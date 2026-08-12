/**
 * Daily Regulatory - 3D regulatory intelligence globe.
 *
 * Renders a dot-matrix Earth with an atmospheric rim, plots each health
 * authority as a marker coloured by the severity of its latest activity, and
 * fires animated arcs between authorities as updates arrive.
 *
 * Continents are generated from an embedded coarse land mask rather than an
 * image texture, so the scene is fully self-contained (no external asset
 * fetches, which the site's Content-Security-Policy forbids).
 */
import * as THREE from '/vendor/three.module.js';

// Coarse land mask: 36 rows of 5 degrees latitude (row 0 = 87.5N),
// 72 columns of 5 degrees longitude (col 0 = 177.5W). Each entry lists the
// inclusive column ranges that contain land.
const LAND_ROWS = [
  [],
  [[19, 31], [38, 40]],
  [[11, 31], [38, 40], [46, 48], [54, 57]],
  [[2, 31], [37, 41], [43, 71]],
  [[2, 32], [36, 71]],
  [[2, 23], [26, 33], [36, 71]],
  [[3, 24], [28, 30], [34, 71]],
  [[6, 24], [34, 71]],
  [[10, 22], [35, 64], [67, 68]],
  [[10, 22], [33, 64]],
  [[10, 21], [33, 64]],
  [[11, 20], [33, 59], [62, 63]],
  [[12, 19], [32, 60]],
  [[13, 20], [32, 46], [49, 60]],
  [[14, 21], [32, 46], [49, 57]],
  [[16, 18], [20, 23], [32, 46], [50, 51], [54, 59]],
  [[19, 25], [33, 44], [51, 51], [55, 56], [59, 60]],
  [[19, 26], [36, 44], [54, 60]],
  [[20, 27], [37, 43], [55, 63]],
  [[20, 29], [37, 43], [55, 64]],
  [[20, 29], [37, 43], [59, 64]],
  [[21, 28], [37, 43], [44, 45], [58, 65]],
  [[21, 28], [38, 42], [44, 45], [58, 66]],
  [[21, 26], [38, 42], [58, 66]],
  [[21, 25], [38, 41], [58, 66]],
  [[20, 25], [62, 65], [69, 71]],
  [[20, 23], [64, 65], [69, 70]],
  [[20, 22]],
  [[20, 22]],
  [],
  [[22, 24]],
  [[0, 71]],
  [[0, 71]],
  [[0, 71]],
  [[0, 71]],
  [[0, 71]],
];

const SEVERITY_COLOURS = {
  critical: new THREE.Color('#ff3b5c'),
  high: new THREE.Color('#ff8a3d'),
  medium: new THREE.Color('#ffd166'),
  info: new THREE.Color('#4ade80'),
  idle: new THREE.Color('#3f7ea8'),
};

const RADIUS = 1;

/** Convert geographic coordinates to a position on the sphere. */
export function latLonToVec3(lat, lon, radius = RADIUS) {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((lon + 180) * Math.PI) / 180;
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  );
}

/**
 * Build the globe inside `container`.
 *
 * @param {HTMLElement} container
 * @param {object} [options]
 * @param {boolean} [options.interactive] enable drag-rotate and marker hover
 * @param {function} [options.onSelect]  called with an authority when clicked
 * @returns {{setAuthorities:Function, pulse:Function, dispose:Function}}
 */
export function createGlobe(container, options = {}) {
  const {
    interactive = true,
    onSelect = null,
    onHover = null,
    // How far the camera sits from the globe: larger values shrink it in frame.
    distance = 3.6,
    // Shifts the globe horizontally in world units, so hero copy can sit beside it.
    offsetX = 0,
    autoRotate = true,
    // Longitude to face the camera initially, in degrees east.
    faceLongitude = -60,
  } = options;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  // Kept on the Z axis: an unbalanced Y here would push the globe off-frame,
  // since the camera looks straight down -Z. Tilt comes from world.rotation.x.
  camera.position.set(0, 0, distance);

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch {
    // WebGL unavailable (older device, blocked context) - the caller falls back
    // to a static presentation rather than a broken canvas.
    return fallback(container);
  }
  if (!renderer.getContext()) return fallback(container);

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  container.appendChild(renderer.domElement);

  // The whole globe hangs off this group so rotation is a single transform.
  const world = new THREE.Group();
  world.rotation.z = (-23.4 * Math.PI) / 180; // axial tilt, purely aesthetic
  world.position.x = offsetX;
  // A point at longitude L faces the camera when rotation.y = -90deg - L.
  world.rotation.y = ((-90 - faceLongitude) * Math.PI) / 180;
  scene.add(world);

  scene.add(buildStarfield());
  world.add(buildCore());
  world.add(buildGraticule());

  const landPoints = buildLandDots();
  world.add(landPoints);

  const atmosphere = buildAtmosphere();
  world.add(atmosphere);

  // --- authority markers -------------------------------------------------

  let authorities = [];
  let markers = null;
  const arcGroup = new THREE.Group();
  world.add(arcGroup);

  function setAuthorities(list) {
    authorities = Array.isArray(list) ? list.filter((a) => Number.isFinite(a.lat)) : [];

    if (markers) {
      world.remove(markers);
      markers.geometry.dispose();
      markers.material.dispose();
      markers = null;
    }
    if (authorities.length === 0) return;

    const positions = new Float32Array(authorities.length * 3);
    const colours = new Float32Array(authorities.length * 3);
    const sizes = new Float32Array(authorities.length);

    authorities.forEach((a, i) => {
      const v = latLonToVec3(a.lat, a.lon, RADIUS * 1.012);
      positions.set([v.x, v.y, v.z], i * 3);

      const colour = SEVERITY_COLOURS[markerSeverity(a)] ?? SEVERITY_COLOURS.idle;
      colours.set([colour.r, colour.g, colour.b], i * 3);

      // Busier authorities read as larger nodes (world-space radius).
      sizes[i] = 0.014 + Math.min(Math.sqrt(a.updateCount ?? 0) * 0.0034, 0.019);
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aColour', new THREE.BufferAttribute(colours, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));

    markers = new THREE.Points(geometry, markerMaterial(pointScaleRef.value));
    markers.renderOrder = 3;
    world.add(markers);
  }

  function markerSeverity(a) {
    if (!a.updateCount) return 'idle';
    if (a.criticalCount > 0) return 'critical';
    if (a.updateCount > 12) return 'high';
    if (a.updateCount > 4) return 'medium';
    return 'info';
  }

  /** Fire an arc from one authority to another to signal new activity. */
  function pulse(fromId, toId) {
    if (reduceMotion || authorities.length < 2) return;

    const from = authorities.find((a) => a.id === fromId) ?? authorities[0];
    const to =
      authorities.find((a) => a.id === toId) ??
      authorities[Math.floor(Math.random() * authorities.length)];
    if (!from || !to || from === to) return;

    const arc = buildArc(
      latLonToVec3(from.lat, from.lon, RADIUS),
      latLonToVec3(to.lat, to.lon, RADIUS),
    );
    arcGroup.add(arc);

    // Remove once the travelling highlight has run off the end of the curve.
    arc.userData.born = performance.now();
  }

  // --- interaction -------------------------------------------------------

  const autoSpin = autoRotate ? 0.00042 : 0;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let velocityX = 0;
  let targetTiltX = 0.18;
  const raycaster = new THREE.Raycaster();
  raycaster.params.Points.threshold = 0.035;
  const pointer = new THREE.Vector2();
  let hovered = null;

  if (interactive) {
    const el = renderer.domElement;
    el.style.cursor = 'grab';

    const onDown = (e) => {
      dragging = true;
      lastX = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
      lastY = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
      el.style.cursor = 'grabbing';
    };
    const onMove = (e) => {
      const x = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
      const y = e.clientY ?? e.touches?.[0]?.clientY ?? 0;

      if (dragging) {
        const dx = x - lastX;
        const dy = y - lastY;
        world.rotation.y += dx * 0.005;
        targetTiltX = THREE.MathUtils.clamp(targetTiltX + dy * 0.004, -0.85, 0.85);
        velocityX = dx * 0.0006;
        lastX = x;
        lastY = y;
      } else if (markers && (onHover || onSelect)) {
        const rect = el.getBoundingClientRect();
        pointer.x = ((x - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((y - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
        const hits = raycaster.intersectObject(markers);

        // Only accept markers on the near side of the globe.
        const hit = hits.find((h) => {
          const world0 = h.point.clone().normalize();
          const toCamera = camera.position.clone().normalize();
          return world0.dot(toCamera) > 0;
        });

        const index = hit?.index ?? null;
        const authority = index === null ? null : authorities[index];
        if (authority !== hovered) {
          hovered = authority;
          el.style.cursor = authority ? 'pointer' : 'grab';
          onHover?.(authority, { x, y });
        }
      }
    };
    const onUp = () => {
      dragging = false;
      el.style.cursor = hovered ? 'pointer' : 'grab';
    };

    el.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    el.addEventListener('click', () => {
      if (hovered && onSelect) onSelect(hovered);
    });

    container._globeCleanup = () => {
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }

  // --- resize + render loop ---------------------------------------------

  function resize() {
    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();

    // Point sizes are given in world units; this factor converts them to
    // pixels for gl_PointSize, and must track the viewport and field of view.
    const pointScale = height / (2 * Math.tan((camera.fov * Math.PI) / 360));
    landPoints.material.uniforms.uScale.value = pointScale;
    if (markers) markers.material.uniforms.uScale.value = pointScale;
    pointScaleRef.value = pointScale;
  }

  // Markers are rebuilt whenever authorities change, so they need the current
  // scale at construction time too.
  const pointScaleRef = { value: 600 };
  resize();

  const observer = new ResizeObserver(resize);
  observer.observe(container);

  let frame = 0;
  let running = true;
  const clock = new THREE.Clock();

  function tick() {
    if (!running) return;
    frame = requestAnimationFrame(tick);

    const elapsed = clock.getElapsedTime();

    if (!dragging) {
      world.rotation.y += autoSpin + velocityX;
      velocityX *= 0.94; // inertia after a drag
    }
    world.rotation.x += (targetTiltX - world.rotation.x) * 0.05;

    if (markers) markers.material.uniforms.uTime.value = elapsed;
    atmosphere.material.uniforms.uTime.value = elapsed;

    // Advance and retire arcs.
    for (const arc of [...arcGroup.children]) {
      const age = (performance.now() - arc.userData.born) / 2600;
      arc.material.uniforms.uHead.value = age;
      if (age > 1.45) {
        arcGroup.remove(arc);
        arc.geometry.dispose();
        arc.material.dispose();
      }
    }

    renderer.render(scene, camera);
  }
  tick();

  // Pause rendering when the tab is hidden or the globe scrolls out of view.
  const visibility = () => {
    if (document.hidden) {
      running = false;
      cancelAnimationFrame(frame);
    } else if (!running) {
      running = true;
      clock.getDelta();
      tick();
    }
  };
  document.addEventListener('visibilitychange', visibility);

  return {
    setAuthorities,
    pulse,
    dispose() {
      running = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener('visibilitychange', visibility);
      container._globeCleanup?.();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

// --------------------------------------------------------------- builders

function fallback(container) {
  container.classList.add('globe-unavailable');
  return { setAuthorities() {}, pulse() {}, dispose() {} };
}

/** Dark inner sphere so back-facing dots do not show through. */
function buildCore() {
  const geometry = new THREE.SphereGeometry(RADIUS * 0.985, 48, 48);
  const material = new THREE.MeshBasicMaterial({ color: 0x0a1626 });
  return new THREE.Mesh(geometry, material);
}

/** Latitude/longitude wireframe, kept very subtle. */
function buildGraticule() {
  const geometry = new THREE.SphereGeometry(RADIUS * 1.001, 36, 24);
  const material = new THREE.MeshBasicMaterial({
    color: 0x1b4160,
    wireframe: true,
    transparent: true,
    opacity: 0.06,
  });
  return new THREE.Mesh(geometry, material);
}

/** Land rendered as a field of glowing dots derived from the land mask. */
function buildLandDots() {
  const positions = [];
  // Each 5-degree mask cell is subdivided so continents read as landmasses
  // rather than a sparse lattice.
  const SUB = 4;

  for (let row = 0; row < LAND_ROWS.length; row++) {
    const latCentre = 87.5 - row * 5;

    for (const [start, end] of LAND_ROWS[row]) {
      for (let col = start; col <= end; col += 1) {
        const lonCentre = -177.5 + col * 5;

        for (let i = 0; i < SUB; i++) {
          const lat = latCentre - 2.5 + (i + 0.5) * (5 / SUB);
          // Meridians converge toward the poles, so take fewer longitude
          // samples there to keep the dots evenly spaced on the surface.
          const lonSamples = Math.max(
            1,
            Math.round(SUB * Math.cos((lat * Math.PI) / 180)),
          );

          for (let j = 0; j < lonSamples; j++) {
            const lon = lonCentre - 2.5 + (j + 0.5) * (5 / lonSamples);
            const v = latLonToVec3(lat, lon, RADIUS * 1.004);
            positions.push(v.x, v.y, v.z);
          }
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      // World-space dot radius; converted to pixels in the shader using
      // uScale, which the renderer keeps in sync with the viewport.
      uSize: { value: 0.0052 },
      uColour: { value: new THREE.Color('#54c8f0') },
      uScale: { value: 600 },
    },
    vertexShader: `
      uniform float uSize;
      uniform float uScale;
      varying float vFacing;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        // Fade dots as they rotate to the far side of the sphere.
        vec3 worldNormal = normalize(mat3(modelMatrix) * normalize(position));
        vec3 toCamera = normalize(cameraPosition - (modelMatrix * vec4(position, 1.0)).xyz);
        vFacing = smoothstep(-0.28, 0.22, dot(worldNormal, toCamera));
        gl_PointSize = uSize * (uScale / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform vec3 uColour;
      varying float vFacing;
      void main() {
        vec2 c = gl_PointCoord - vec2(0.5);
        float d = length(c);
        if (d > 0.5) discard;
        float edge = 1.0 - smoothstep(0.32, 0.5, d);
        gl_FragColor = vec4(uColour, edge * vFacing * 0.92);
      }
    `,
  });

  const points = new THREE.Points(geometry, material);
  points.renderOrder = 2;
  return points;
}

/** Authority markers: pulsing discs with a soft halo. */
function markerMaterial(pointScale = 600) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uScale: { value: pointScale },
    },
    vertexShader: `
      attribute vec3 aColour;
      attribute float aSize;
      uniform float uTime;
      uniform float uScale;
      varying vec3 vColour;
      varying float vFacing;
      varying float vPulse;
      void main() {
        vColour = aColour;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec3 worldNormal = normalize(mat3(modelMatrix) * normalize(position));
        vec3 toCamera = normalize(cameraPosition - (modelMatrix * vec4(position, 1.0)).xyz);
        vFacing = smoothstep(-0.05, 0.35, dot(worldNormal, toCamera));
        // Stagger the pulse per marker so they do not beat in unison.
        vPulse = 0.82 + 0.18 * sin(uTime * 2.1 + position.x * 9.0 + position.y * 5.0);
        // aSize is a world-space radius; uScale converts it to pixels.
        gl_PointSize = aSize * vPulse * (uScale / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      varying vec3 vColour;
      varying float vFacing;
      varying float vPulse;
      void main() {
        vec2 c = gl_PointCoord - vec2(0.5);
        float d = length(c);
        if (d > 0.5) discard;
        float core = 1.0 - smoothstep(0.0, 0.22, d);
        float halo = (1.0 - smoothstep(0.2, 0.5, d)) * 0.42;
        float a = (core + halo) * vFacing * vPulse;
        gl_FragColor = vec4(vColour, a);
      }
    `,
  });
}

/** Fresnel rim light that reads as atmosphere. */
function buildAtmosphere() {
  const geometry = new THREE.SphereGeometry(RADIUS * 1.16, 64, 64);
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uColour: { value: new THREE.Color('#22d3ee') },
      uColour2: { value: new THREE.Color('#8b5cf6') },
    },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vPosition;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vPosition = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColour;
      uniform vec3 uColour2;
      uniform float uTime;
      varying vec3 vNormal;
      varying vec3 vPosition;
      void main() {
        float rim = pow(max(0.72 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 0.0), 3.6);
        // Slow drift between the two accent hues around the limb.
        float mixer = 0.5 + 0.5 * sin(uTime * 0.28 + vPosition.y * 1.6);
        vec3 colour = mix(uColour, uColour2, mixer);
        gl_FragColor = vec4(colour, clamp(rim, 0.0, 1.0) * 0.4);
      }
    `,
  });
  return new THREE.Mesh(geometry, material);
}

/** Background starfield, drawn once and never updated. */
function buildStarfield() {
  const count = 1400;
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    // Distribute on a large shell around the camera.
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = 26 + Math.random() * 22;
    positions.set(
      [
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.sin(phi) * Math.sin(theta),
        r * Math.cos(phi),
      ],
      i * 3,
    );
    sizes[i] = Math.random() * 1.7 + 0.35;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uDpr: { value: Math.min(window.devicePixelRatio, 2) } },
    vertexShader: `
      attribute float aSize;
      uniform float uDpr;
      varying float vSize;
      void main() {
        vSize = aSize;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uDpr * 1.6;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      varying float vSize;
      void main() {
        vec2 c = gl_PointCoord - vec2(0.5);
        if (length(c) > 0.5) discard;
        gl_FragColor = vec4(0.75, 0.85, 1.0, vSize * 0.36);
      }
    `,
  });

  return new THREE.Points(geometry, material);
}

/**
 * A great-circle-ish arc lifted off the surface, with a travelling highlight
 * driven by the uHead uniform.
 */
function buildArc(from, to) {
  const segments = 64;
  const distance = from.distanceTo(to);
  const lift = 0.16 + distance * 0.28;

  const points = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    // Spherical interpolation keeps the arc hugging the globe, then we push it
    // outward with a sine so it bows away from the surface.
    const point = new THREE.Vector3().copy(from).lerp(to, t).normalize();
    point.multiplyScalar(RADIUS + Math.sin(t * Math.PI) * lift);
    points.push(point);
  }

  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const ts = new Float32Array(points.length);
  for (let i = 0; i < points.length; i++) ts[i] = i / segments;
  geometry.setAttribute('aT', new THREE.BufferAttribute(ts, 1));

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uHead: { value: 0 },
      uColour: { value: new THREE.Color('#4de3ff') },
    },
    vertexShader: `
      attribute float aT;
      varying float vT;
      void main() {
        vT = aT;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uHead;
      uniform vec3 uColour;
      varying float vT;
      void main() {
        // A comet: bright head with a tail trailing behind it.
        float tail = smoothstep(uHead - 0.42, uHead, vT);
        float head = 1.0 - smoothstep(uHead, uHead + 0.03, vT);
        float a = tail * head;
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColour, a * 0.85);
      }
    `,
  });

  const line = new THREE.Line(geometry, material);
  line.renderOrder = 4;
  return line;
}
