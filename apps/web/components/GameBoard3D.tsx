'use client'

import { Canvas, useThree, useFrame } from '@react-three/fiber'
import { useGLTF, useAnimations, OrbitControls } from '@react-three/drei'
import { Suspense, useEffect, useMemo, useCallback, useState, useRef } from 'react'
import * as THREE from 'three'
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js'
import { buildGrid, getReachableCells } from '../lib/game-engine'
import type { PlayerGameView, Position } from '@repo/stellar'
import { MAP_W, MAP_H } from '@repo/stellar'

// ─── Camera modes ─────────────────────────────────────────────────────────────

type ViewMode = 'angled' | 'topdown'

const CAMERA_CONFIGS: Record<ViewMode, { position: [number, number, number]; target: [number, number, number] }> = {
  angled:  { position: [0, 15, 21],    target: [0, 0, 0] },
  topdown: { position: [0, 36, 0.01],  target: [0, 0, 0] },
}

function CameraController({ mode }: { mode: ViewMode }) {
  const { camera, controls } = useThree()

  useEffect(() => {
    const cfg = CAMERA_CONFIGS[mode]
    camera.position.set(...cfg.position)
    camera.lookAt(...cfg.target)
    camera.updateProjectionMatrix()
    // Reset pan target to center when switching modes
    if (controls) {
      const oc = controls as unknown as { target: THREE.Vector3; update: () => void }
      oc.target.set(...cfg.target)
      oc.update()
    }
  }, [mode, camera, controls])

  return null
}

// Max world-space distance the camera target can drift from (0,0,0).
// The top-down view at y=36/fov=45 already sees ~30 units wide — the whole
// 12×12 map fits with margin — so only a small pan offset is allowed.
const PAN_LIMIT = 3

function TopDownPanLimiter() {
  const { camera, controls } = useThree()

  useFrame(() => {
    if (!controls) return
    const oc = controls as unknown as { target: THREE.Vector3; update: () => void }

    const tx = THREE.MathUtils.clamp(oc.target.x, -PAN_LIMIT, PAN_LIMIT)
    const tz = THREE.MathUtils.clamp(oc.target.z, -PAN_LIMIT, PAN_LIMIT)

    const dx = tx - oc.target.x
    const dz = tz - oc.target.z

    if (dx !== 0 || dz !== 0) {
      oc.target.x = tx
      oc.target.z = tz
      camera.position.x += dx
      camera.position.z += dz
    }
  })

  return null
}

// ─── Grid computation ─────────────────────────────────────────────────────────

const GRID = 12

interface GridData {
  positions: THREE.Vector3[]
  dotY: number
  dx: number
  dz: number
}

function findInnerBounds(sorted: number[]): { lo: number; hi: number } {
  if (sorted.length < 2) return { lo: sorted[0]!, hi: sorted[sorted.length - 1]! }
  const total = sorted[sorted.length - 1]! - sorted[0]!
  const threshold = total * 0.05
  let lo = sorted[0]!
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]! - sorted[i - 1]! > threshold) break
    lo = sorted[i]!
  }
  let hi = sorted[sorted.length - 1]!
  for (let i = sorted.length - 2; i >= 0; i--) {
    if (sorted[i + 1]! - sorted[i]! > threshold) break
    hi = sorted[i]!
  }
  if (lo > hi) { const t = lo; lo = hi; hi = t }
  return { lo, hi }
}

function computeGrid(scene: THREE.Group): GridData | null {
  scene.updateWorldMatrix(true, true)

  let border: THREE.Mesh | null = null
  scene.traverse((obj) => {
    if (!border && obj instanceof THREE.Mesh && /Cube[._]?029_Baked/.test(obj.name)) border = obj
  })
  if (!border) return null

  const geo = (border as THREE.Mesh).geometry
  const attr = geo.attributes.position
  const mat = (border as THREE.Mesh).matrixWorld
  const xs: number[] = [], ys: number[] = [], zs: number[] = []
  const v = new THREE.Vector3()
  for (let i = 0; i < attr.count; i++) {
    v.set(attr.getX(i), attr.getY(i), attr.getZ(i)).applyMatrix4(mat)
    xs.push(v.x); ys.push(v.y); zs.push(v.z)
  }
  xs.sort((a, b) => a - b)
  ys.sort((a, b) => a - b)
  zs.sort((a, b) => a - b)

  const { lo: xMin, hi: xMax } = findInnerBounds(xs)
  const { lo: zMin, hi: zMax } = findInnerBounds(zs)
  const dotY = ys[ys.length - 1]! + 0.01

  const dx = (xMax - xMin) / GRID
  const dz = (zMax - zMin) / GRID

  const positions: THREE.Vector3[] = []
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      positions.push(new THREE.Vector3(
        xMin + dx * col + dx / 2,
        dotY,
        zMin + dz * row + dz / 2,
      ))
    }
  }
  return { positions, dotY, dx, dz }
}

// ─── Cell model loader ────────────────────────────────────────────────────────

function CellModel({
  name,
  position,
  rotationY = 0,
}: {
  name: string
  position: THREE.Vector3
  rotationY?: number
}) {
  const { scene, animations } = useGLTF(`/models/${name}.glb`)

  const { clone, wrapper } = useMemo(() => {
    const c = SkeletonUtils.clone(scene) as THREE.Group
    c.updateWorldMatrix(true, true)

    const box = new THREE.Box3().setFromObject(c)
    const center = new THREE.Vector3()
    box.getCenter(center)

    let hasSkinnedMesh = false
    let diskWorldY = 0
    let foundDisk = false
    let armature: THREE.Object3D | null = null
    let skinnedMinY = Infinity

    c.traverse((obj) => {
      if (!foundDisk && obj instanceof THREE.Mesh && !(obj instanceof THREE.SkinnedMesh)) {
        const wp = new THREE.Vector3()
        obj.getWorldPosition(wp)
        diskWorldY = wp.y
        foundDisk = true
      }
      if (!armature && obj.name === 'Armature') armature = obj
      if (obj instanceof THREE.SkinnedMesh) {
        hasSkinnedMesh = true
        const smBox = new THREE.Box3().setFromObject(obj)
        if (smBox.min.y < skinnedMinY) skinnedMinY = smBox.min.y
      }
    })

    if (hasSkinnedMesh && armature && isFinite(skinnedMinY)) {
      c.position.set(-center.x, -diskWorldY, -center.z)
      ;(armature as THREE.Object3D).position.y += diskWorldY - skinnedMinY
    } else {
      c.position.set(-center.x, -box.min.y, -center.z)
    }

    const g = new THREE.Group()
    g.add(c)
    return { clone: c, wrapper: g }
  }, [scene, name])

  const { actions } = useAnimations(animations, clone)

  useEffect(() => {
    const idle = Object.values(actions)[0]
    idle?.reset().setLoop(THREE.LoopRepeat, Infinity).play()
  }, [actions])

  return (
    <primitive object={wrapper} position={[position.x, position.y, position.z]} rotation={[0, rotationY, 0]} />
  )
}

// ─── Exit cell — procedural hex platform + floating arrow ─────────────────────

function ExitCell({ position, dx, dz }: { position: THREE.Vector3; dx: number; dz: number }) {
  const arrowRef  = useRef<THREE.Group>(null)
  const ringRef   = useRef<THREE.Mesh>(null)
  const glowRef   = useRef<THREE.Mesh>(null)

  const size = Math.min(dx, dz) * 0.46

  useFrame(({ clock }) => {
    const t = clock.elapsedTime

    // Arrow: bob up-down + slow rotation
    if (arrowRef.current) {
      arrowRef.current.position.y = position.y + 0.28 + Math.sin(t * 2.2) * 0.07
      arrowRef.current.rotation.y = t * 0.6
    }

    // Outer ring: pulse emissive intensity
    if (ringRef.current) {
      const mat = ringRef.current.material as THREE.MeshStandardMaterial
      mat.emissiveIntensity = 0.6 + Math.sin(t * 3) * 0.4
    }

    // Inner glow disc: breathe opacity
    if (glowRef.current) {
      const mat = glowRef.current.material as THREE.MeshStandardMaterial
      mat.opacity = 0.35 + Math.sin(t * 2.5 + 1) * 0.15
    }
  })

  const GREEN = '#22c55e'

  return (
    <group>
      {/* Hex fill */}
      <mesh
        ref={glowRef}
        position={[position.x, position.y + 0.012, position.z]}
        rotation={[-Math.PI / 2, 0, 0]}
      >
        <circleGeometry args={[size, 6]} />
        <meshStandardMaterial
          color={GREEN}
          emissive={GREEN}
          emissiveIntensity={0.5}
          transparent
          opacity={0.4}
          depthWrite={false}
        />
      </mesh>

      {/* Hex border ring */}
      <mesh
        ref={ringRef}
        position={[position.x, position.y + 0.016, position.z]}
        rotation={[-Math.PI / 2, 0, 0]}
      >
        <ringGeometry args={[size * 0.88, size, 6]} />
        <meshStandardMaterial
          color={GREEN}
          emissive={GREEN}
          emissiveIntensity={0.8}
          transparent
          opacity={0.9}
          depthWrite={false}
        />
      </mesh>

      {/* Floating upward arrow */}
      <group ref={arrowRef} position={[position.x, position.y + 0.28, position.z]}>
        {/* Shaft */}
        <mesh position={[0, -0.055, 0]}>
          <cylinderGeometry args={[0.012, 0.012, 0.11, 8]} />
          <meshStandardMaterial color={GREEN} emissive={GREEN} emissiveIntensity={1.2} />
        </mesh>
        {/* Head */}
        <mesh position={[0, 0.04, 0]}>
          <coneGeometry args={[0.042, 0.09, 6]} />
          <meshStandardMaterial color={GREEN} emissive={GREEN} emissiveIntensity={1.4} />
        </mesh>
      </group>
    </group>
  )
}

// ─── Flat highlight plane ─────────────────────────────────────────────────────

function CellHighlight({
  position,
  dx,
  dz,
  color,
  opacity,
  onClick,
}: {
  position: THREE.Vector3
  dx: number
  dz: number
  color: string
  opacity: number
  onClick?: () => void
}) {
  return (
    <mesh
      position={[position.x, position.y + 0.015, position.z]}
      rotation={[-Math.PI / 2, 0, 0]}
      onClick={onClick}
    >
      <planeGeometry args={[dx * 0.92, dz * 0.92]} />
      <meshStandardMaterial color={color} transparent opacity={opacity} depthWrite={false} />
    </mesh>
  )
}

// ─── Invisible click catcher ──────────────────────────────────────────────────

function CellClickTarget({
  position,
  dx,
  dz,
  onClick,
}: {
  position: THREE.Vector3
  dx: number
  dz: number
  onClick: () => void
}) {
  return (
    <mesh
      position={[position.x, position.y + 0.01, position.z]}
      rotation={[-Math.PI / 2, 0, 0]}
      onClick={onClick}
    >
      <planeGeometry args={[dx, dz]} />
      <meshStandardMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  )
}

// ─── 3D game scene ────────────────────────────────────────────────────────────

interface GameSceneProps {
  view: PlayerGameView
  playerAddress: string
  roll: number | null
  selectedPath: Position[]
  onCellClick: (x: number, y: number) => void
  isMyTurn: boolean
}

function GameScene3D({
  view,
  playerAddress,
  roll,
  selectedPath,
  onCellClick,
  isMyTurn,
}: GameSceneProps) {
  const { scene, animations } = useGLTF('/models/map.glb')
  const { actions } = useAnimations(animations, scene)

  const grid        = useMemo(() => buildGrid(view, playerAddress), [view, playerAddress])
  const gridData    = useMemo(() => computeGrid(scene), [scene])

  // Reachable cells
  const reachableCells = useMemo(() => {
    if (!isMyTurn || !roll) return new Set<string>()
    return new Set(getReachableCells(view, playerAddress, roll).map((p) => `${p.x},${p.y}`))
  }, [view, playerAddress, roll, isMyTurn])

  // Selected path
  const pathSet = useMemo(
    () => new Set(selectedPath.map((p) => `${p.x},${p.y}`)),
    [selectedPath],
  )
  const pathEnd = selectedPath.length > 0 ? selectedPath[selectedPath.length - 1] : null

  // Camera detection zones (cross: same row or column within radius)
  const cameraZoneCells = useMemo(() => {
    const set = new Set<string>()
    for (const cam of view.visibleCameras) {
      for (let d = 1; d <= cam.radius; d++) {
        if (cam.y - d >= 0)      set.add(`${cam.x},${cam.y - d}`)
        if (cam.y + d < MAP_H)   set.add(`${cam.x},${cam.y + d}`)
        if (cam.x - d >= 0)      set.add(`${cam.x - d},${cam.y}`)
        if (cam.x + d < MAP_W)   set.add(`${cam.x + d},${cam.y}`)
      }
    }
    return set
  }, [view.visibleCameras])

  // Laser orientation per cell (vertical if same x = x1===x2, else horizontal)
  const laserOrientations = useMemo(() => {
    const map = new Map<string, 'horizontal' | 'vertical'>()
    for (const laser of view.visibleLasers) {
      if (laser.x1 === laser.x2) {
        for (let y = laser.y1; y <= laser.y2; y++) map.set(`${laser.x1},${y}`, 'vertical')
      } else {
        for (let x = laser.x1; x <= laser.x2; x++) map.set(`${x},${laser.y1}`, 'horizontal')
      }
    }
    return map
  }, [view.visibleLasers])

  // Loop map animations
  useEffect(() => {
    Object.values(actions).forEach((a) => a?.reset().setLoop(THREE.LoopRepeat, Infinity).play())
  }, [actions])

  const handleClick = useCallback(
    (x: number, y: number) => onCellClick(x, y),
    [onCellClick],
  )

  if (!gridData) return <primitive object={scene} />

  const { positions, dx, dz } = gridData

  return (
    <>
      <primitive object={scene} />

      {grid.flatMap((row, y) =>
        row.map((cell, x) => {
          const pos = positions[y * GRID + x]
          if (!pos || !cell.revealed) return null

          const cellKey = `${x}-${y}`
          const xyKey   = `${x},${y}`
          const isReachable    = isMyTurn && reachableCells.has(xyKey)
          const isOnPath       = pathSet.has(xyKey)
          const isPathEnd      = pathEnd?.x === x && pathEnd?.y === y
          const inCameraZone   = cameraZoneCells.has(xyKey)
          const clickHandler   = isReachable ? () => handleClick(x, y) : undefined

          const laserRotY =
            laserOrientations.get(xyKey) === 'vertical' ? Math.PI / 2 : 0

          return (
            <group key={cellKey}>
              {/* ── 3D models ── */}
              {cell.wall && (
                <Suspense fallback={null}>
                  <CellModel name="wall" position={pos} />
                </Suspense>
              )}
              {cell.camera && !cell.wall && (
                <Suspense fallback={null}>
                  <CellModel name="camera" position={pos} />
                </Suspense>
              )}
              {cell.laser && !cell.wall && (
                <Suspense fallback={null}>
                  <CellModel name="laser" position={pos} rotationY={laserRotY} />
                </Suspense>
              )}
              {cell.loot && !cell.wall && (
                <Suspense fallback={null}>
                  <CellModel name="loot" position={pos} />
                </Suspense>
              )}
              {cell.isExit && (
                <ExitCell position={pos} dx={dx} dz={dz} />
              )}
              {cell.hasPlayer1 && (
                <Suspense fallback={null}>
                  <CellModel name="characterblue" position={pos} />
                </Suspense>
              )}
              {cell.hasPlayer2 && (
                <Suspense fallback={null}>
                  <CellModel name="charactergreen" position={pos} />
                </Suspense>
              )}

              {/* ── Highlights (back → front) ── */}

              {/* Revealed base — subtle for explored area */}
              {!cell.wall && (
                <CellHighlight
                  position={pos}
                  dx={dx}
                  dz={dz}
                  color="#94a3b8"
                  opacity={0.09}
                />
              )}

              {/* Camera detection zone — red */}
              {!cell.wall && inCameraZone && !isOnPath && !isReachable && (
                <CellHighlight
                  position={pos}
                  dx={dx}
                  dz={dz}
                  color="#ef4444"
                  opacity={0.22}
                />
              )}

              {/* Reachable — green */}
              {isReachable && !isOnPath && (
                <CellHighlight
                  position={pos}
                  dx={dx}
                  dz={dz}
                  color="#4ade80"
                  opacity={0.25}
                  onClick={clickHandler}
                />
              )}

              {/* On path — blue */}
              {isOnPath && !isPathEnd && (
                <CellHighlight
                  position={pos}
                  dx={dx}
                  dz={dz}
                  color="#3b82f6"
                  opacity={0.45}
                  onClick={clickHandler}
                />
              )}

              {/* Path end — amber */}
              {isPathEnd && (
                <CellHighlight
                  position={pos}
                  dx={dx}
                  dz={dz}
                  color="#f59e0b"
                  opacity={0.65}
                  onClick={clickHandler}
                />
              )}

              {/* Invisible click zone for non-highlighted reachable cells */}
              {!isReachable && !isOnPath && isMyTurn && (
                <CellClickTarget
                  position={pos}
                  dx={dx}
                  dz={dz}
                  onClick={() => handleClick(x, y)}
                />
              )}
            </group>
          )
        }),
      )}
    </>
  )
}

// ─── Preload all models ───────────────────────────────────────────────────────

useGLTF.preload('/models/map.glb')
useGLTF.preload('/models/wall.glb')
useGLTF.preload('/models/loot.glb')
useGLTF.preload('/models/camera.glb')
useGLTF.preload('/models/laser.glb')

useGLTF.preload('/models/characterblue.glb')
useGLTF.preload('/models/charactergreen.glb')

// ─── View-mode toggle button ──────────────────────────────────────────────────

function ViewToggleButton({
  mode,
  onToggle,
}: {
  mode: ViewMode
  onToggle: () => void
}) {
  return (
    <button
      onClick={onToggle}
      className="absolute left-4 z-10 flex items-center gap-2 px-3 py-2 rounded-lg bg-heist-card/80 backdrop-blur-sm border border-heist-border text-sm text-gray-300 hover:text-white hover:bg-heist-card/95 transition-all select-none"
      style={{ top: '60px' }}
      title={mode === 'angled' ? 'Switch to top-down view' : 'Switch to angled view'}
    >
      {mode === 'angled' ? (
        <>
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
          Top View
        </>
      ) : (
        <>
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          3D View
        </>
      )}
    </button>
  )
}

// ─── Public component ─────────────────────────────────────────────────────────

export interface GameBoard3DProps {
  view: PlayerGameView
  playerAddress: string
  roll: number | null
  selectedPath: Position[]
  onCellClick: (x: number, y: number) => void
  isMyTurn: boolean
}

export function GameBoard3D(props: GameBoard3DProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('angled')

  return (
    <>
      <Canvas
        shadows
        camera={{ position: CAMERA_CONFIGS.angled.position, fov: 45, near: 0.01, far: 1000 }}
        gl={{ antialias: true }}
        style={{ position: 'absolute', inset: 0 }}
      >
        <CameraController mode={viewMode} />

        {/* Top-down: pan only — no zoom, no rotation, clamped to map bounds */}
        {viewMode === 'topdown' && (
          <>
            <OrbitControls
              makeDefault
              enableRotate={false}
              enableZoom={false}
              enablePan={true}
              screenSpacePanning={true}
            />
            <TopDownPanLimiter />
          </>
        )}

        <ambientLight intensity={0.6} />
        <directionalLight position={[12, 18, 10]} intensity={1.4} castShadow />
        <directionalLight position={[-8, 8, -5]} intensity={0.3} />

        <Suspense fallback={null}>
          <GameScene3D {...props} />
        </Suspense>
      </Canvas>

      <ViewToggleButton
        mode={viewMode}
        onToggle={() => setViewMode((m) => (m === 'angled' ? 'topdown' : 'angled'))}
      />
    </>
  )
}
