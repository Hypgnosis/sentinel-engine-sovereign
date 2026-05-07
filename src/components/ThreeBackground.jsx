import React, { useRef, useState, useCallback, Suspense } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Float, Environment, ContactShadows, PresentationControls } from '@react-three/drei';
import { WebGLMonitor, useWebGLInitMonitor } from './WebGLMonitor';
import DataGrid from './DataGrid';
import { Monitor, Cpu } from 'lucide-react';

/**
 * SENTINEL ENGINE V4.9-RC — Three.js Background with 2D Fallback
 * ═══════════════════════════════════════════════════════════════
 * Renders the floating octahedron + torus knot in WebGL.
 * If WebGL init > 3s or FPS < 20 for 3s, automatically
 * pivots to the DataGrid 2D fallback.
 *
 * User can manually toggle via the 3D/2D switch.
 * ═══════════════════════════════════════════════════════════════
 */

const ReadyMarker = ({ onReady }) => {
  const calledRef = useRef(false);
  useFrame(() => {
    if (!calledRef.current) {
      calledRef.current = true;
      onReady?.();
    }
  });
  return null;
};

const FloatingCore = () => {
  const meshRef = useRef();
  const sphereRef = useRef();

  useFrame((state, delta) => {
    if (meshRef.current) {
      meshRef.current.rotation.y += delta * 0.1;
      meshRef.current.rotation.z += delta * 0.05;
    }

    if (sphereRef.current) {
      const t = state.clock.getElapsedTime();
      sphereRef.current.position.y = Math.sin(t * 0.5) * 0.2;
    }
  });

  return (
    <group ref={meshRef}>
      <Float speed={2} rotationIntensity={0.5} floatIntensity={0.5}>
        <mesh ref={sphereRef}>
          <octahedronGeometry args={[1, 2]} />
          <meshPhysicalMaterial
            color="#D4B2FF"
            emissive="#D4B2FF"
            emissiveIntensity={0.5}
            roughness={0.1}
            metalness={0.9}
            clearcoat={1}
            transmission={0.5}
            thickness={0.5}
            envMapIntensity={1.5}
          />
        </mesh>
      </Float>

      {/* Outer Cage */}
      <mesh scale={[1.5, 1.5, 1.5]} rotation={[0, 0, 0]}>
        <torusKnotGeometry args={[1, 0.02, 128, 16]} />
        <meshPhysicalMaterial
          color="#D4B2FF"
          metalness={1}
          roughness={0}
          opacity={0.3}
          transparent
        />
      </mesh>
    </group>
  );
};

// ── Demo data for the 2D fallback grid ──
const DEMO_GRID_DATA = [
  { port: 'Shanghai', congestion: 'HIGH', vessels: 147, waitDays: 3.2, trend: 'up' },
  { port: 'Rotterdam', congestion: 'LOW', vessels: 42, waitDays: 1.1, trend: 'stable' },
  { port: 'Long Beach', congestion: 'MODERATE', vessels: 89, waitDays: 2.4, trend: 'up' },
  { port: 'Singapore', congestion: 'LOW', vessels: 63, waitDays: 0.8, trend: 'down' },
  { port: 'Busan', congestion: 'MEDIUM', vessels: 71, waitDays: 1.7, trend: 'stable' },
  { port: 'Hamburg', congestion: 'LOW', vessels: 38, waitDays: 1.0, trend: 'down' },
  { port: 'Jeddah', congestion: 'HIGH', vessels: 112, waitDays: 4.1, trend: 'up' },
  { port: 'Durban', congestion: 'MODERATE', vessels: 56, waitDays: 2.0, trend: 'stable' },
];

export const ThreeBackground = ({ gridData, forceMode }) => {
  const [mode, setMode] = useState(forceMode || '3d'); // '3d' | '2d'

  const handleFallback = useCallback(() => {
    console.warn('[THREE_BG] Pivoting to 2D Data Grid mode.');
    setMode('2d');
  }, []);

  const { markReady } = useWebGLInitMonitor(3000, handleFallback);

  // Allow external force
  const activeMode = forceMode || mode;

  // ── 2D Fallback Mode ──
  if (activeMode === '2d') {
    return (
      <div className="fixed inset-0 z-[-1] overflow-hidden pointer-events-none opacity-30">
        <div className="absolute inset-0 flex items-center justify-center p-8">
          <DataGrid
            data={gridData || DEMO_GRID_DATA}
            title="SOVEREIGN GRID — Port Intelligence"
            className="pointer-events-auto max-w-4xl w-full"
          />
        </div>

        {/* Mode Toggle */}
        <ModeToggle mode={activeMode} setMode={setMode} />
      </div>
    );
  }

  // ── 3D Mode ──
  return (
    <div className="fixed inset-0 z-[-1] overflow-hidden pointer-events-none opacity-40">
      <Suspense fallback={
        <div className="w-full h-full flex items-center justify-center">
          <div className="text-xs font-mono text-text-muted animate-pulse">INITIALIZING WEBGL...</div>
        </div>
      }>
        <Canvas camera={{ position: [0, 0, 5], fov: 45 }}>
          <ambientLight intensity={0.5} />
          <spotLight position={[10, 10, 10]} angle={0.15} penumbra={1} intensity={1} />
          <PresentationControls
            global
            config={{ mass: 2, tension: 500 }}
            snap={{ mass: 4, tension: 1500 }}
            rotation={[0, 0, 0]}
            polar={[-Math.PI / 3, Math.PI / 3]}
            azimuth={[-Math.PI / 1.4, Math.PI / 1.4]}
          >
            <FloatingCore />
          </PresentationControls>
          <ContactShadows resolution={1024} scale={20} blur={2} opacity={0.25} far={10} color="#000000" />
          <Environment preset="city" />

          {/* V4.9-RC: Performance monitor + ready marker */}
          <WebGLMonitor onFallback={handleFallback} />
          <ReadyMarker onReady={markReady} />
        </Canvas>
      </Suspense>

      {/* Mode Toggle */}
      <ModeToggle mode={activeMode} setMode={setMode} />
    </div>
  );
};

// ── 3D/2D Toggle Button ──
const ModeToggle = ({ mode, setMode }) => (
  <div className="absolute bottom-4 right-4 pointer-events-auto z-10">
    <button
      onClick={() => setMode(mode === '3d' ? '2d' : '3d')}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-obsidian-border bg-obsidian/90 backdrop-blur-md hover:border-cyber-purple/50 transition-all duration-300 cursor-pointer group"
      title={mode === '3d' ? 'Switch to Sovereign Grid (2D)' : 'Switch to 3D Visualization'}
    >
      {mode === '3d' ? (
        <>
          <Monitor className="w-3.5 h-3.5 text-text-muted group-hover:text-cyber-purple transition-colors" />
          <span className="text-[10px] font-mono text-text-muted group-hover:text-text-primary tracking-wider">2D GRID</span>
        </>
      ) : (
        <>
          <Cpu className="w-3.5 h-3.5 text-text-muted group-hover:text-cyber-purple transition-colors" />
          <span className="text-[10px] font-mono text-text-muted group-hover:text-text-primary tracking-wider">3D VIEW</span>
        </>
      )}
    </button>
  </div>
);
