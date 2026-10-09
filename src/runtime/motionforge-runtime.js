/*! MotionForge runtime - scroll-controlled canvas / WebGL animation.
 *  Dependencies: none. Network access: none (only loads the image URLs you give it).
 *  Reads a validated JSON scene; it never evaluates code from the scene. */
(function (g) {
  'use strict';
  var PI = Math.PI;
  var TAU = PI * 2;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function frac(v) { return ((v % 1) + 1) % 1; }

  var easings = {
    linear: function (t) { return t; },
    easeIn: function (t) { return t * t; },
    easeOut: function (t) { return 1 - (1 - t) * (1 - t); },
    easeInOut: function (t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; },
    cinematic: function (t) { return t * t * t * (t * (t * 6 - 15) + 10); }
  };

  // Evenly spaced values across 0..1, linearly interpolated.
  function sampleArray(a, t) {
    if (!a || !a.length) return 0;
    if (a.length === 1) return a[0];
    var f = clamp(t, 0, 1) * (a.length - 1);
    var i = Math.min(Math.floor(f), a.length - 2);
    return a[i] + (a[i + 1] - a[i]) * (f - i);
  }

  function crom(a, b, c, d, u) {
    return 0.5 * ((2 * b) + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u * u + (-a + 3 * b - 3 * c + d) * u * u * u);
  }

  // Catmull-Rom curve through keyframes ({progress, x, y}); x/y are % of the stage.
  function samplePath(path, t) {
    var p = path.slice().sort(function (a, b) { return a.progress - b.progress; });
    var n = p.length;
    if (t <= p[0].progress) return { x: p[0].x, y: p[0].y };
    if (t >= p[n - 1].progress) return { x: p[n - 1].x, y: p[n - 1].y };
    var i = 0;
    while (i < n - 2 && t > p[i + 1].progress) i++;
    var p0 = p[Math.max(i - 1, 0)], p1 = p[i], p2 = p[i + 1], p3 = p[Math.min(i + 2, n - 1)];
    var span = p2.progress - p1.progress;
    var u = span > 0 ? (t - p1.progress) / span : 0;
    return { x: crom(p0.x, p1.x, p2.x, p3.x, u), y: crom(p0.y, p1.y, p2.y, p3.y, u) };
  }

  // Pure function of (object, progress): the same progress always gives the same pose,
  // which is what makes scrolling backwards exactly reverse the animation.
  // `lookup(id)` finds another object, so an object can be attached to (follow) another one.
  function evaluate(obj, progress, lookup, depth) {
    depth = depth || 0;
    var span = obj.end - obj.start;
    var raw = span > 0 ? clamp((progress - obj.start) / span, 0, 1) : 0;
    var ease = easings[obj.easing] || easings.linear;
    var t = ease(raw);

    var target = obj.attachTo && lookup && depth < 3 ? lookup(obj.attachTo) : null;
    var attached = !!target && target.id !== obj.id;
    var pos;
    if (attached) {
      var tp = evaluate(target, progress, lookup, depth + 1);
      pos = { x: tp.x + (obj.offsetX || 0), y: tp.y + (obj.offsetY || 0) };
    } else {
      pos = obj.pinned ? { x: obj.path[0].x, y: obj.path[0].y } : samplePath(obj.path, t);
    }

    var tilt = 0;
    if (obj.followPath && !obj.pinned && !attached) {
      var a = samplePath(obj.path, clamp(t + 0.01, 0, 1));
      var b = samplePath(obj.path, clamp(t - 0.01, 0, 1));
      tilt = clamp(Math.atan2(a.y - b.y, a.x - b.x) * 180 / PI * 0.25, -25, 25);
    }
    // Parallax: a layer that drifts against the scroll, for depth between layers.
    var y = pos.y + (obj.parallax ? obj.parallax * (progress - 0.5) * 40 : 0) + (obj.bob ? obj.bob * Math.sin(t * obj.bobCycles * 2 * PI) : 0);
    return {
      x: pos.x,
      y: y,
      rotation: sampleArray(obj.rotation, t) + tilt,
      scale: sampleArray(obj.scale, t),
      opacity: clamp(sampleArray(obj.opacity, t), 0, 1),
      blur: Math.max(0, sampleArray(obj.blur || [0], t)),
      t: t,
      phase: raw * (obj.motion ? obj.motion.cycles : (obj.flapsPerScroll || 0)),
      cycle: obj.effect ? raw * obj.effect.loops : 0
    };
  }

  // ---- particle effects ---------------------------------------------------------------------
  function hash(n) {
    n = (n ^ 61) ^ (n >>> 16);
    n = (n + (n << 3)) | 0;
    n = n ^ (n >>> 4);
    n = Math.imul(n, 0x27d4eb2d);
    n = n ^ (n >>> 15);
    return (n >>> 0) / 4294967296;
  }
  function rnd(seed, i, k) { return hash(Math.imul(seed + 1, 73856093) ^ Math.imul(i + 1, 19349663) ^ Math.imul(k + 1, 83492791)); }
  // Two uniforms summed: -1..1, bunched in the middle, so emitters are dense at the centre and thin at the edges.
  function tri(a, b) { return a + b - 1; }
  function wrap(v, lo, span) { return lo + frac((v - lo) / span) * span; }

  function hexToRgb(h) {
    return [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
  }
  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function shade(c, k) { return [c[0] * k, c[1] * k, c[2] * k]; }

  var WHITE = [1, 1, 1];
  // Flame colour by temperature, hottest first: white-yellow core, the effect's colour, orange, dull red.
  var FIRE_CORE = [1, 0.95, 0.78];
  var FIRE_MID = [1, 0.32, 0.04];
  var FIRE_END = [0.42, 0.05, 0.01];
  function fireColor(base, heat) {
    if (heat > 0.85) return mix(base, FIRE_CORE, (heat - 0.85) / 0.15);
    if (heat > 0.4) return mix(FIRE_MID, base, (heat - 0.4) / 0.45);
    return mix(FIRE_END, FIRE_MID, heat / 0.4);
  }

  /** Floats per particle in computeParticles' output. */
  var STRIDE = 9;

  /**
   * Every particle's position is a pure function of (effect, particle index, cycle), so particles
   * scrub forwards and backwards exactly like everything else. Returns a flat array of
   * x, y, size, r, g, b, a, angle, stretch per particle: pixels (size is the radius), 0-1 colour,
   * radians (0 = long axis vertical) and how many times longer than wide the particle is drawn.
   */
  function computeParticles(effect, pose, w, h, mobileScale) {
    var n = effect.count;
    var data = new Float32Array(n * STRIDE);
    var s = clamp(w / 1440, 0.4, 1.5) * (mobileScale || 1);
    var ex = pose.x * w / 100;
    var ey = pose.y * h / 100;
    var spread = effect.spread / 100 * w;
    var rise = effect.rise / 100 * h;
    var base = hexToRgb(effect.color);
    var type = effect.type;
    var seed = effect.seed;
    var cycle = pose.cycle;
    // The whole effect shares one breeze, so neighbouring particles move together like a real plume.
    var windDir = rnd(seed, 0, 99) < 0.5 ? -1 : 1;
    for (var i = 0; i < n; i++) {
      var r1 = rnd(seed, i, 1), r2 = rnd(seed, i, 2), r3 = rnd(seed, i, 3), r4 = rnd(seed, i, 4), r5 = rnd(seed, i, 5), r6 = rnd(seed, i, 6);
      // Particles live at slightly different speeds so they never pulse in step.
      var u = frac(cycle * (0.8 + 0.4 * r6) + rnd(seed, i, 0));
      var x, y, size, a, col = base, angle = 0, stretch = 1;
      if (type === 'smoke') {
        // Buoyant smoke shoots up, then slows, spreads into a widening plume and drifts downwind.
        var hy = 1 - Math.pow(1 - u, 1.8);
        var width = spread * (0.25 + 1.6 * hy);
        var swirl = Math.sin(hy * 5.5 - cycle * 2.1 + seed) + 0.5 * Math.sin(hy * 11 + cycle * 3.4 + r2 * 2);
        x = ex + tri(r1, r4) * width * 0.5 + swirl * spread * 0.45 * hy + windDir * hy * hy * rise * 0.18;
        y = ey - hy * rise * (0.75 + 0.35 * r2);
        size = effect.size * s * (0.35 + 1.9 * Math.sqrt(u)) * (0.75 + 0.5 * r3);
        a = 0.42 * Math.min(1, u * 10) * Math.pow(1 - u, 1.5);
        col = shade(base, 0.8 + 0.2 * Math.min(1, u * 3) + (r5 - 0.5) * 0.14);
        angle = r5 * TAU + (r2 - 0.5) * 2 * u;
      } else if (type === 'fire') {
        if (i % 12 === 0) {
          // Embers: tiny glowing bits carried well above the flames, zig-zagging on the updraft.
          x = ex + tri(r1, r4) * spread * 0.4 + Math.sin(u * TAU * (1.5 + r2) + r5 * TAU) * spread * 0.7 * u + windDir * u * spread;
          y = ey - u * rise * (1.6 + 1.2 * r2);
          size = effect.size * s * 0.1 * (0.6 + 0.8 * r3);
          a = Math.min(1, u * 6) * (1 - u) * (0.6 + 0.4 * Math.sin(u * 40 + r5 * TAU));
          col = fireColor(base, 0.55 - 0.4 * u);
        } else {
          // Flames: hot gas accelerates upwards and narrows into tongues that flicker and sway.
          var off = tri(r1, r4);
          var lift = (0.45 * u + 0.55 * u * u) * rise * (0.65 + 0.7 * r2);
          var sway = Math.sin(cycle * 4.3 + lift / Math.max(rise, 1) * 3 + seed) * spread * 0.18 * u;
          x = ex + off * spread * 0.5 * (1 - 0.8 * u) + sway + Math.sin(u * 9 + cycle * 7 + r2 * TAU) * spread * 0.06 * u;
          y = ey - lift;
          size = effect.size * s * (1 - 0.7 * u) * (0.7 + 0.6 * r3) * (0.85 + 0.15 * Math.sin(cycle * 23 + r5 * TAU));
          a = 0.6 * Math.min(1, u * 6) * Math.pow(1 - u, 1.2);
          // The centre and the base burn hottest; the edges and the tips cool to red.
          col = fireColor(base, clamp(1 - u * (1 + 0.3 * r5) - Math.abs(off) * 0.35, 0, 1));
          stretch = 1.7 - 0.5 * u;
          angle = -sway / Math.max(spread, 1) * 1.5;
        }
      } else if (type === 'water') {
        var vx, vy;
        if (i % 8 === 0) {
          // Splashes where the falling water lands.
          var land = ex + tri(r1, r4) * spread;
          var hop = rise * 0.08 * (0.4 + r2);
          vx = (r5 - 0.5) * spread * 0.3;
          x = land + vx * u;
          y = ey - 4 * hop * u * (1 - u);
          vy = -4 * hop * (1 - 2 * u);
          size = effect.size * s * 0.45 * (0.6 + 0.8 * r3);
          a = 0.7 * (1 - u);
        } else {
          // Droplets are thrown up, slowed by gravity and fall back: a parabola, densest in the central jet.
          var peak = rise * (0.65 + 0.35 * r2) * (1 - 0.35 * Math.abs(tri(r1, r4)));
          vx = tri(r1, r4) * spread;
          x = ex + vx * u;
          y = ey - 4 * peak * u * (1 - u);
          vy = -4 * peak * (1 - 2 * u);
          size = effect.size * s * (r3 < 0.25 ? 0.35 : 0.6 + 0.7 * r3);
          a = 0.85 * Math.min(1, u * 12) * (1 - Math.pow(u, 6));
        }
        // Fast drops blur into short streaks along their direction of travel; they are round at the top of the arc.
        var speed = Math.sqrt(vx * vx + vy * vy);
        stretch = 1 + Math.min(3, speed / Math.max(rise * 1.6, 1) * 3);
        angle = Math.atan2(-vx, vy);
        col = mix(base, WHITE, r5 * 0.4);
      } else if (type === 'sparkle') {
        // Glints burst out, slow down in the air and drift up, flashing on and off.
        var ang = r1 * TAU;
        var dist = spread * (0.25 + 0.75 * r2) * (1 - Math.pow(1 - u, 2.5));
        var tw = Math.pow(0.5 + 0.5 * Math.sin(u * TAU * (2 + 3 * r4) + r5 * TAU), 2);
        x = ex + Math.cos(ang) * dist;
        y = ey + Math.sin(ang) * dist * 0.8 - u * rise * 0.3;
        size = effect.size * s * (1 + r3) * (0.6 + 0.8 * tw) * (1 - 0.4 * u);
        a = (0.35 + 0.65 * tw) * Math.min(1, u * 8) * Math.pow(1 - u, 0.8);
        col = mix(base, WHITE, 0.55 * tw);
        angle = (r6 - 0.5) * 0.5 + u * (r2 - 0.5);
      } else {
        // Snow and rain fill the whole stage. Each particle has a depth: near ones are bigger,
        // faster and sharper, far ones small, slow and faint, which gives the scene real depth.
        var rain = type === 'rain';
        var z = r3;
        var depthSpeed = rain ? 0.7 + 0.6 * z : 0.5 + 0.9 * z;
        var uf = frac(cycle * depthSpeed + rnd(seed, i, 0));
        var m = 0.08 * h;
        var drift = windDir * (rain ? 0.12 : 0.05) * w * (0.4 + z);
        y = -m + uf * (h + 2 * m);
        if (rain) {
          x = wrap(r1 * w + drift * uf, -m, w + 2 * m);
          size = effect.size * s * 0.35 * (0.5 + z);
          stretch = 7 + 9 * z;
          angle = Math.atan2(-drift, h + 2 * m);
          a = 0.22 + 0.5 * z;
          col = mix(base, WHITE, 0.25 * z);
        } else {
          var flutter = Math.sin(uf * TAU * (1.2 + r4 * 1.8) + r2 * TAU) * (8 + 26 * z) * s;
          x = wrap(r1 * w + drift * uf + flutter, -m, w + 2 * m);
          size = effect.size * s * (0.3 + 1.1 * Math.pow(z, 1.5));
          a = 0.3 + 0.6 * z;
        }
      }
      var o = i * STRIDE;
      data[o] = x; data[o + 1] = y; data[o + 2] = Math.max(0.5, size);
      data[o + 3] = clamp(col[0], 0, 1); data[o + 4] = clamp(col[1], 0, 1); data[o + 5] = clamp(col[2], 0, 1);
      data[o + 6] = clamp(a * pose.opacity, 0, 1);
      data[o + 7] = angle; data[o + 8] = stretch;
    }
    return data;
  }

  function isAdditive(effect) { return effect.type === 'fire' || effect.type === 'sparkle'; }
  // The particle shape each effect is drawn with.
  function particleStyle(effect) { return effect.type === 'smoke' ? 'puff' : effect.type === 'sparkle' ? 'glint' : 'soft'; }

  // WebGL pays off for lots of particles; below this, plain canvas keeps true layer order.
  var GL_THRESHOLD = 250;
  function chooseRenderer(scene, glAvailable) {
    var total = 0;
    for (var i = 0; i < scene.objects.length; i++) {
      if (scene.objects[i].effect) total += scene.objects[i].effect.count;
    }
    return glAvailable && total >= GL_THRESHOLD ? 'webgl' : 'canvas2d';
  }

  var glProbe = null;
  function webglAvailable() {
    if (glProbe !== null) return glProbe;
    try {
      var c = document.createElement('canvas');
      glProbe = !!(c.getContext('webgl'));
    } catch (e) { glProbe = false; }
    return glProbe;
  }

  // White particle shapes (alpha masks), shared by the canvas and WebGL renderers so both look the same.
  var SPRITE = 64;
  var masks = {};
  function mask(style) {
    if (masks[style]) return masks[style];
    var c = document.createElement('canvas');
    c.width = c.height = SPRITE;
    var x = c.getContext('2d');
    var R = SPRITE / 2;
    function blob(cx, cy, r, alpha) {
      // Roughly Gaussian falloff: no hard edge anywhere.
      var g2 = x.createRadialGradient(cx, cy, 0, cx, cy, r);
      g2.addColorStop(0, 'rgba(255,255,255,' + alpha + ')');
      g2.addColorStop(0.3, 'rgba(255,255,255,' + alpha * 0.75 + ')');
      g2.addColorStop(0.6, 'rgba(255,255,255,' + alpha * 0.3 + ')');
      g2.addColorStop(0.85, 'rgba(255,255,255,' + alpha * 0.07 + ')');
      g2.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g2;
      x.fillRect(0, 0, SPRITE, SPRITE);
    }
    if (style === 'puff') {
      // A billowing cloud: a cluster of overlapping soft lumps instead of one smooth disc.
      blob(R, R, R * 0.75, 0.5);
      for (var k = 0; k < 9; k++) {
        var ang = rnd(7, k, 1) * TAU, d = R * (0.12 + 0.3 * rnd(7, k, 2));
        blob(R + Math.cos(ang) * d, R + Math.sin(ang) * d, R * (0.3 + 0.25 * rnd(7, k, 3)), 0.4);
      }
    } else if (style === 'glint') {
      // A bright point with a soft halo and a four-pointed star flare.
      blob(R, R, R, 0.35);
      blob(R, R, R * 0.5, 1);
      x.globalCompositeOperation = 'lighter';
      for (var v = 0; v < 2; v++) {
        var lg = v ? x.createLinearGradient(R, 0, R, SPRITE) : x.createLinearGradient(0, R, SPRITE, R);
        lg.addColorStop(0, 'rgba(255,255,255,0)');
        lg.addColorStop(0.5, 'rgba(255,255,255,0.9)');
        lg.addColorStop(1, 'rgba(255,255,255,0)');
        x.fillStyle = lg;
        if (v) x.fillRect(R - 2, 0, 4, SPRITE); else x.fillRect(0, R - 2, SPRITE, 4);
      }
    } else {
      blob(R, R, R, 1);
    }
    masks[style] = c;
    return c;
  }

  var VS = 'attribute vec2 a_pos;attribute float a_size;attribute vec4 a_color;attribute vec2 a_shape;uniform vec2 u_res;uniform float u_dpr;uniform float u_max;' +
    'varying vec4 v_color;varying vec3 v_shape;' +
    'void main(){vec2 c=a_pos/u_res*2.0-1.0;gl_Position=vec4(c.x,-c.y,0.0,1.0);gl_PointSize=min(a_size*2.0*a_shape.y*u_dpr,u_max);' +
    'v_color=a_color;v_shape=vec3(cos(a_shape.x),sin(a_shape.x),a_shape.y);}';
  // Turn the square point into a rotated, stretched sprite, matching the canvas renderer's transform.
  var FS = 'precision mediump float;uniform sampler2D u_tex;varying vec4 v_color;varying vec3 v_shape;' +
    'void main(){vec2 p=gl_PointCoord-0.5;vec2 l=vec2(v_shape.x*p.x+v_shape.y*p.y,-v_shape.y*p.x+v_shape.x*p.y);' +
    'vec2 uv=vec2(l.x*v_shape.z,l.y)+0.5;if(uv.x<0.0||uv.x>1.0||uv.y<0.0||uv.y>1.0)discard;' +
    'float k=texture2D(u_tex,uv).a*v_color.a;gl_FragColor=vec4(v_color.rgb*k,k);}';

  function createGLLayer(canvas) {
    var gl = null;
    try { gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true }); } catch (e) { gl = null; }
    if (!gl) return null;
    function shader(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    }
    var vs = shader(gl.VERTEX_SHADER, VS), fs = shader(gl.FRAGMENT_SHADER, FS);
    if (!vs || !fs) return null;
    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);
    var buf = gl.createBuffer();
    var loc = {
      pos: gl.getAttribLocation(prog, 'a_pos'), size: gl.getAttribLocation(prog, 'a_size'), color: gl.getAttribLocation(prog, 'a_color'),
      shape: gl.getAttribLocation(prog, 'a_shape'),
      res: gl.getUniformLocation(prog, 'u_res'), dpr: gl.getUniformLocation(prog, 'u_dpr'), max: gl.getUniformLocation(prog, 'u_max')
    };
    var range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
    var maxPoint = range && range[1] ? Math.min(range[1], 512) : 64;
    var textures = {};
    function texture(style) {
      if (textures[style]) return textures[style];
      var t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mask(style));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      textures[style] = t;
      return t;
    }
    gl.enable(gl.BLEND);
    var bytes = STRIDE * 4;
    return {
      canvas: canvas,
      draw: function (batches, w, h, dpr) {
        var cw = Math.round(w * dpr), ch = Math.round(h * dpr);
        if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
        gl.viewport(0, 0, cw, ch);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform2f(loc.res, w, h);
        gl.uniform1f(loc.dpr, dpr);
        gl.uniform1f(loc.max, maxPoint);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        for (var b = 0; b < batches.length; b++) {
          var batch = batches[b];
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, texture(batch.style));
          gl.blendFunc(gl.ONE, batch.additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
          gl.bufferData(gl.ARRAY_BUFFER, batch.data, gl.DYNAMIC_DRAW);
          gl.enableVertexAttribArray(loc.pos);
          gl.vertexAttribPointer(loc.pos, 2, gl.FLOAT, false, bytes, 0);
          gl.enableVertexAttribArray(loc.size);
          gl.vertexAttribPointer(loc.size, 1, gl.FLOAT, false, bytes, 8);
          gl.enableVertexAttribArray(loc.color);
          gl.vertexAttribPointer(loc.color, 4, gl.FLOAT, false, bytes, 12);
          gl.enableVertexAttribArray(loc.shape);
          gl.vertexAttribPointer(loc.shape, 2, gl.FLOAT, false, bytes, 28);
          gl.drawArrays(gl.POINTS, 0, batch.data.length / STRIDE);
        }
      }
    };
  }

  // A tinted copy of a particle shape per quantised colour, for the canvas renderer.
  var sprites = {};
  function sprite(style, r, g, b) {
    var key = style + ((Math.round(r * 15) << 8) | (Math.round(g * 15) << 4) | Math.round(b * 15));
    if (sprites[key]) return sprites[key];
    var c = document.createElement('canvas');
    c.width = c.height = SPRITE;
    var x = c.getContext('2d');
    x.drawImage(mask(style), 0, 0);
    x.globalCompositeOperation = 'source-in';
    x.fillStyle = 'rgb(' + Math.round(r * 255) + ',' + Math.round(g * 255) + ',' + Math.round(b * 255) + ')';
    x.fillRect(0, 0, SPRITE, SPRITE);
    sprites[key] = c;
    return c;
  }

  function drawParticles2D(ctx, data, style, additive, dpr) {
    ctx.save();
    ctx.globalCompositeOperation = additive ? 'lighter' : 'source-over';
    for (var i = 0; i < data.length; i += STRIDE) {
      var a = data[i + 6];
      if (a <= 0.002) continue;
      var d = data[i + 2] * 2, st = data[i + 8];
      var c = Math.cos(data[i + 7]) * dpr, sn = Math.sin(data[i + 7]) * dpr;
      ctx.globalAlpha = a;
      ctx.setTransform(c, sn, -sn, c, data[i] * dpr, data[i + 1] * dpr);
      ctx.drawImage(sprite(style, data[i + 3], data[i + 4], data[i + 5]), -d / 2, -d * st / 2, d, d * st);
    }
    ctx.restore();
  }

  var SVGNS = 'http://www.w3.org/2000/svg';

  // The curve a line draws, as an SVG path in 0-100 stage units.
  function pathD(path) {
    var a = path.slice().sort(function (p, q) { return p.progress - q.progress; });
    var first = a[0].progress, last = a[a.length - 1].progress;
    var d = '';
    for (var i = 0; i <= 60; i++) {
      var p = samplePath(a, first + (last - first) * i / 60);
      d += (i ? 'L' : 'M') + p.x.toFixed(2) + ' ' + p.y.toFixed(2);
    }
    return d;
  }

  function sampleFrameIndex(phase, count, playback) {
    if (count <= 1) return 0;
    var frame = playback === 'once' ? clamp(phase, 0, 1) * (count - 1) : frac(phase) * count;
    return Math.round(frame) % count;
  }

  function mount(host, config, options) {
    options = options || {};
    var scene = config.scene;
    var assets = config.assets || {};
    var stageHeight = options.stageHeight || '100vh';
    var reduced = !!(g.matchMedia && g.matchMedia('(prefers-reduced-motion: reduce)').matches);

    host.innerHTML = '';
    var track = document.createElement('div');
    track.className = 'mf-track';
    // The animation must never intercept clicks meant for the page it is embedded in.
    track.style.cssText = 'position:relative;width:100%;pointer-events:none;';
    var stage = document.createElement('div');
    stage.className = 'mf-stage';
    // 100dvh follows the visible area on phones, where the address bar comes and goes; 100vh is the fallback.
    stage.style.cssText = 'position:sticky;top:0;width:100%;height:' + stageHeight + ';' + (stageHeight === '100vh' ? 'height:100dvh;' : '') + 'overflow:hidden;pointer-events:none;';
    var canvas = document.createElement('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Scroll-controlled animation');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;background:transparent;';
    stage.appendChild(canvas);
    track.appendChild(stage);
    host.appendChild(track);
    var ctx = canvas.getContext('2d');

    var byId = {};
    function index() {
      byId = {};
      for (var i = 0; i < scene.objects.length; i++) byId[scene.objects[i].id] = scene.objects[i];
    }
    function lookup(id) { return byId[id] || null; }
    index();

    // Effects use WebGL layers when the scene is heavy enough and the browser supports it.
    var glBack = null, glFront = null, effectsMode = 'canvas2d';
    function layerCanvas(front) {
      var c = document.createElement('canvas');
      c.setAttribute('aria-hidden', 'true');
      c.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;background:transparent;';
      if (front) stage.appendChild(c); else stage.insertBefore(c, canvas);
      return c;
    }
    function dropGL() {
      if (glBack) { glBack.canvas.remove(); glBack = null; }
      if (glFront) { glFront.canvas.remove(); glFront = null; }
    }
    function syncRenderer() {
      var want = options.renderer === 'canvas2d' ? 'canvas2d' : chooseRenderer(scene, webglAvailable());
      if (want === 'webgl') {
        if (!glBack && !glFront) {
          var bc = layerCanvas(false), fc = layerCanvas(true);
          glBack = createGLLayer(bc);
          glFront = createGLLayer(fc);
          if (!glBack || !glFront) { bc.remove(); fc.remove(); glBack = glFront = null; want = 'canvas2d'; }
        }
      } else { dropGL(); }
      effectsMode = want;
    }
    syncRenderer();

    // Simple shapes are HTML/CSS elements and lines are SVG, each in a layer behind or in front of the canvas.
    var domBack = document.createElement('div'), domFront = document.createElement('div');
    var domCss = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
    domBack.style.cssText = domCss;
    domFront.style.cssText = domCss;
    domBack.setAttribute('aria-hidden', 'true');
    domFront.setAttribute('aria-hidden', 'true');
    stage.insertBefore(domBack, stage.firstChild);
    stage.appendChild(domFront);
    var domNodes = [];
    var usesHtml = false, usesSvg = false;

    function buildDom() {
      domBack.innerHTML = '';
      domFront.innerHTML = '';
      domNodes = [];
      usesHtml = usesSvg = false;
      var svgs = {};
      function svgFor(layerName) {
        if (!svgs[layerName]) {
          var s = document.createElementNS(SVGNS, 'svg');
          s.setAttribute('viewBox', '0 0 100 100');
          s.setAttribute('preserveAspectRatio', 'none');
          s.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;overflow:visible;';
          (layerName === 'back' ? domBack : domFront).appendChild(s);
          svgs[layerName] = s;
        }
        return svgs[layerName];
      }
      for (var i = 0; i < scene.objects.length; i++) {
        var o = scene.objects[i];
        if (o.shape) {
          var el = document.createElement('div');
          el.className = 'mf-shape';
          el.style.cssText = 'position:absolute;left:0;top:0;will-change:transform,opacity;background:' + o.shape.color + ';' +
            'width:' + o.shape.widthPct + '%;height:' + o.shape.heightPct + '%;' +
            'border-radius:' + (o.shape.type === 'circle' ? '50%' : o.shape.radius + '%') + ';';
          (o.shape.layer === 'back' ? domBack : domFront).appendChild(el);
          domNodes.push({ obj: o, el: el, shape: true });
          usesHtml = true;
        } else if (o.line) {
          var src = (o.attachTo && byId[o.attachTo]) ? byId[o.attachTo].path : o.path;
          var pe = document.createElementNS(SVGNS, 'path');
          pe.setAttribute('d', pathD(src));
          pe.setAttribute('fill', 'none');
          pe.setAttribute('stroke', o.line.color);
          pe.setAttribute('stroke-width', String(o.line.width));
          pe.setAttribute('stroke-linecap', o.line.cap);
          pe.setAttribute('stroke-linejoin', 'round');
          pe.setAttribute('vector-effect', 'non-scaling-stroke');
          if (o.line.reveal === 'draw') pe.setAttribute('pathLength', '1');
          else if (o.line.dash > 0) pe.setAttribute('stroke-dasharray', o.line.dash + ' ' + o.line.dash);
          svgFor(o.line.layer).appendChild(pe);
          domNodes.push({ obj: o, el: pe, shape: false });
          usesSvg = true;
        }
      }
    }
    buildDom();

    function updateDom(mobile) {
      for (var i = 0; i < domNodes.length; i++) {
        var n = domNodes[i], o = n.obj, st = evaluate(o, shown, lookup);
        if (n.shape) {
          var sc = st.scale * (mobile ? o.mobileScale : 1);
          n.el.style.left = st.x + '%';
          n.el.style.top = st.y + '%';
          n.el.style.transform = 'translate(-50%,-50%) rotate(' + st.rotation + 'deg) scale(' + sc + ')';
          n.el.style.opacity = String(st.opacity);
          n.el.style.filter = st.blur > 0 ? 'blur(' + st.blur + 'px)' : 'none';
        } else {
          n.el.style.opacity = String(st.opacity);
          if (o.line.reveal === 'draw') {
            n.el.style.strokeDasharray = '1';
            n.el.style.strokeDashoffset = String(1 - st.t);
          }
        }
      }
    }

    var imgs = {};
    var loaded = false;
    function loadImages() {
      if (loaded) return;
      loaded = true;
      Object.keys(assets).forEach(function (id) {
        imgs[id] = assets[id].map(function (url) {
          var im = new Image();
          im.decoding = 'async';
          im.onload = requestDraw;
          im.src = url;
          return im;
        });
      });
    }

    var target = reduced ? 0.5 : 0;
    var shown = target;
    var maxSeen = 0;
    var last = 0;
    var raf = 0;
    var visible = true;

    function layout() {
      track.style.height = reduced ? stage.offsetHeight + 'px' : (scene.scroll.length + stage.offsetHeight) + 'px';
    }

    function readProgress() {
      var max = track.offsetHeight - stage.offsetHeight;
      if (max <= 0) return 0;
      return clamp(-track.getBoundingClientRect().top / max, 0, 1);
    }

    function onScroll() {
      if (reduced) return;
      var p = readProgress();
      // Editing must allow rewinding, even when the exported scene is configured
      // for forward-only playback. Otherwise a path edit remains stuck at its end.
      if (!options.preview && !scene.scroll.reverse) { p = Math.max(p, maxSeen); maxSeen = p; }
      target = p;
      requestDraw();
    }

    function requestDraw() { if (!raf) raf = g.requestAnimationFrame(tick); }

    function tick(now) {
      raf = 0;
      if (!visible) return;
      var dt = last ? Math.min(0.1, (now - last) / 1000) : 0.016;
      last = now;
      var tau = scene.scroll.smoothing;
      if (reduced || tau <= 0) { shown = target; }
      else {
        shown += (target - shown) * (1 - Math.exp(-dt / tau));
        if (Math.abs(target - shown) < 0.0002) shown = target;
      }
      draw();
      if (shown !== target) requestDraw(); else last = 0;
    }

    function draw() {
      var w = stage.clientWidth, h = stage.clientHeight;
      if (!w || !h) return;
      var dpr = Math.min(g.devicePixelRatio || 1, 2);
      var cw = Math.round(w * dpr), ch = Math.round(h * dpr);
      if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      var mobile = w < 768;
      var canBlur = 'filter' in ctx;
      var back = [], front = [];
      for (var i = 0; i < scene.objects.length; i++) {
        var obj = scene.objects[i];
        var st = evaluate(obj, shown, lookup);

        if (obj.effect) {
          var data = computeParticles(obj.effect, st, w, h, mobile ? obj.mobileScale : 1);
          var additive = isAdditive(obj.effect), style = particleStyle(obj.effect);
          if (effectsMode === 'webgl') (obj.effect.layer === 'back' ? back : front).push({ data: data, additive: additive, style: style });
          else drawParticles2D(ctx, data, style, additive, dpr);
          continue;
        }

        var frames = imgs[obj.assetId];
        if (!frames || !frames.length) continue;
        var n = frames.length;
        var phase = reduced ? 0 : st.phase;
        // Use one pose per frame: alpha-over blending leaves a second wing
        // silhouette visible throughout a stroke, especially on transparent assets.
        var idx = sampleFrameIndex(phase, n, obj.motion && obj.motion.playback);
        var a = frames[idx];
        if (!a.complete || !a.naturalWidth) continue;
        var dw = w * obj.widthPct / 100 * st.scale * (mobile ? obj.mobileScale : 1);
        var dh = dw * a.naturalHeight / a.naturalWidth;
        ctx.save();
        ctx.translate(st.x * w / 100, st.y * h / 100);
        ctx.rotate(st.rotation * PI / 180);
        ctx.globalAlpha = st.opacity;
        if (canBlur) ctx.filter = st.blur > 0 ? 'blur(' + st.blur + 'px)' : 'none';
        ctx.drawImage(a, -dw / 2, -dh / 2, dw, dh);
        ctx.restore();
      }
      if (effectsMode === 'webgl') {
        glBack.draw(back, w, h, dpr);
        glFront.draw(front, w, h, dpr);
      }
      updateDom(mobile);
    }

    function onResize() { layout(); onScroll(); requestDraw(); }

    var io = null;
    if (g.IntersectionObserver) {
      io = new g.IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        if (visible) { loadImages(); onScroll(); requestDraw(); }
      }, { rootMargin: '300px 0px' });
      io.observe(host);
    } else { loadImages(); }

    layout();
    g.addEventListener('scroll', onScroll, { passive: true });
    g.addEventListener('resize', onResize);
    if (!io) requestDraw();
    onScroll();
    requestDraw();

    return {
      update: function (newScene) { scene = newScene; index(); syncRenderer(); buildDom(); layout(); onScroll(); requestDraw(); },
      getProgress: function () { return shown; },
      info: function () { return { effects: effectsMode, shapes: usesHtml ? 'html' : null, lines: usesSvg ? 'svg' : null }; },
      destroy: function () {
        g.removeEventListener('scroll', onScroll);
        g.removeEventListener('resize', onResize);
        if (io) io.disconnect();
        if (raf) g.cancelAnimationFrame(raf);
        host.innerHTML = '';
      }
    };
  }

  g.MotionForge = {
    mount: mount, evaluate: evaluate, samplePath: samplePath, sampleArray: sampleArray, sampleFrameIndex: sampleFrameIndex, easings: easings,
    computeParticles: computeParticles, PARTICLE_STRIDE: STRIDE, chooseRenderer: chooseRenderer
  };
})(typeof window !== 'undefined' ? window : globalThis);
