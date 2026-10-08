"use client";
import { useEffect, useRef, useState } from "react";

const DURATION_MS = 3200;

// Smooth, deterministic hills with a winding river valley (no random noise → same scene every load).
function height(x: number, z: number) {
  const hills =
    1.4 * Math.sin(x * 0.18) * Math.cos(z * 0.21) +
    0.9 * Math.sin(x * 0.41 + 1.3) * Math.sin(z * 0.33 + 0.4) +
    0.45 * Math.cos(x * 0.83 - z * 0.57);
  const riverZ = 4 * Math.sin(x * 0.12);
  const valley = Math.exp(-((z - riverZ) ** 2) / 18);
  return hills + 2.2 - 3.6 * valley;
}

export default function FloodIntro({ onDone }: { onDone: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [leaving, setLeaving] = useState(false);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  }, [onDone]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let cancelled = false;
    let frame = 0;
    let cleanup = () => {};
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const finish = () => {
      if (cancelled) return;
      setLeaving(true);
      window.setTimeout(() => done.current(), 600);
    };
    const end = window.setTimeout(finish, reduced ? 1200 : DURATION_MS);
    const skip = () => {
      window.clearTimeout(end);
      finish();
    };
    window.addEventListener("keydown", skip, { once: true });
    el.addEventListener("click", skip, { once: true });

    void import("three").then((THREE) => {
      if (cancelled) return;
      let renderer: InstanceType<typeof THREE.WebGLRenderer>;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      } catch {
        return; // no WebGL: the gradient and title still show
      }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(el.clientWidth, el.clientHeight);
      el.prepend(renderer.domElement);

      const scene = new THREE.Scene();
      scene.fog = new THREE.Fog(0xf1f3f7, 34, 70);
      const camera = new THREE.PerspectiveCamera(38, el.clientWidth / el.clientHeight, 0.1, 200);

      const geo = new THREE.PlaneGeometry(64, 44, 128, 88);
      geo.rotateX(-Math.PI / 2);
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++)
        pos.setY(i, height(pos.getX(i), pos.getZ(i)));
      geo.computeVertexNormals();
      const land = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({ color: 0xdfe3ee, flatShading: true, roughness: 0.95 }),
      );
      const grid = new THREE.LineSegments(
        new THREE.WireframeGeometry(geo),
        new THREE.LineBasicMaterial({ color: 0x161a3a, transparent: true, opacity: 0.09 }),
      );
      scene.add(land, grid);

      const water = new THREE.Mesh(
        new THREE.PlaneGeometry(64, 44).rotateX(-Math.PI / 2),
        new THREE.MeshStandardMaterial({
          color: 0x2f6fe6,
          transparent: true,
          opacity: 0.55,
          roughness: 0.25,
          metalness: 0.1,
        }),
      );
      scene.add(water);

      // incident pins on higher ground, the colours used on the map
      const pins = [
        [-14, -6, 0xd92d48],
        [-4, 7, 0xe08a12],
        [8, -9, 0xe08a12],
        [16, 5, 0x0e9f6e],
      ].map(([x, z, color]) => {
        const pin = new THREE.Mesh(
          new THREE.SphereGeometry(0.55, 24, 16),
          new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35 }),
        );
        pin.position.set(x, height(x, z) + 1.4, z);
        scene.add(pin);
        return pin;
      });

      scene.add(new THREE.HemisphereLight(0xffffff, 0xc3c9db, 1.6));
      const sun = new THREE.DirectionalLight(0xffffff, 1.4);
      sun.position.set(-12, 20, 10);
      scene.add(sun);

      const start = performance.now();
      const draw = (now: number) => {
        const t = reduced ? 1 : Math.min(1, (now - start) / DURATION_MS);
        const ease = 1 - (1 - t) ** 3;
        water.position.y = -1.6 + ease * 2.1; // the river slowly overtops the valley
        const angle = -0.35 + ease * 0.5;
        camera.position.set(Math.sin(angle) * 34, 17 - ease * 3, Math.cos(angle) * 34);
        camera.lookAt(0, 0, 0);
        pins.forEach((pin, i) => pin.scale.setScalar(Math.min(1, Math.max(0, ease * 3 - i * 0.4))));
        renderer.render(scene, camera);
        if (!reduced && t < 1) frame = requestAnimationFrame(draw);
      };
      frame = requestAnimationFrame(draw);

      const onResize = () => {
        renderer.setSize(el.clientWidth, el.clientHeight);
        camera.aspect = el.clientWidth / el.clientHeight;
        camera.updateProjectionMatrix();
        renderer.render(scene, camera);
      };
      window.addEventListener("resize", onResize);
      cleanup = () => {
        window.removeEventListener("resize", onResize);
        scene.traverse((o) => {
          const mesh = o as { geometry?: { dispose(): void }; material?: { dispose(): void } };
          mesh.geometry?.dispose();
          mesh.material?.dispose();
        });
        renderer.dispose();
        renderer.domElement.remove();
      };
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(end);
      window.removeEventListener("keydown", skip);
      cleanup();
    };
  }, []);

  return (
    <div
      ref={host}
      className={`flood-intro ${leaving ? "leaving" : ""}`}
      role="status"
      aria-live="polite"
    >
      <div className="flood-intro-copy">
        <h2>Disaster Relief Router</h2>
        <p>Flood reports in. Safe, approved help out.</p>
      </div>
    </div>
  );
}
