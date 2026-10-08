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
      phase: raw * (obj.flapsPerScroll || 0),
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

  function hexToRgb(h) {
    return [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
  }
  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

  var FIRE_MID = [1, 0.23, 0];
  var FIRE_END = [0.25, 0.06, 0];

  /**
   * Every particle's position is a pure function of (effect, particle index, cycle), so particles
   * scrub forwards and backwards exactly like everything else. Returns a flat array of
   * x, y, size, r, g, b, a per particle (pixels, 0-1 colour).
   */
  function computeParticles(effect, pose, w, h, mobileScale) {
    var n = effect.count;
    var data = new Float32Array(n * 7);
    var s = clamp(w / 1440, 0.4, 1.5) * (mobileScale || 1);
    var ex = pose.x * w / 100;
    var ey = pose.y * h / 100;
    var spread = effect.spread / 100 * w;
    var rise = effect.rise / 100 * h;
    var base = hexToRgb(effect.color);
    var type = effect.type;
    var seed = effect.seed;
    for (var i = 0; i < n; i++) {
      var u = frac(pose.cycle + rnd(seed, i, 0));
      var r1 = rnd(seed, i, 1), r2 = rnd(seed, i, 2), r3 = rnd(seed, i, 3);
      var x, y, size, a, col = base;
      if (type === 'smoke') {
        x = ex + (r1 - 0.5) * spread * (0.4 + u) + Math.sin(u * 3 + r2 * TAU) * 8 * s * u;
        y = ey - u * rise;
        size = effect.size * s * (0.5 + 1.5 * u);
        a = 0.55 * (1 - u) * Math.min(1, u * 8);
      } else if (type === 'fire') {
        x = ex + (r1 - 0.5) * spread * (1 - u * 0.6) + Math.sin(u * 10 + r2 * TAU) * 3 * s;
        y = ey - u * rise;
        size = effect.size * s * (1 - 0.7 * u) * (0.7 + 0.6 * r3);
        a = 0.9 * (1 - u);
        col = u < 0.5 ? mix(base, FIRE_MID, u * 2) : mix(FIRE_MID, FIRE_END, (u - 0.5) * 2);
      } else if (type === 'water') {
        x = ex + (r1 - 0.5) * spread * 2 * u;
        y = ey - rise * 4 * u * (1 - u) * (0.6 + 0.4 * r2);
        size = effect.size * s * (0.6 + 0.8 * r3);
        a = 0.8 * Math.min(1, u * 10) * (1 - u * u);
      } else if (type === 'sparkle') {
        var ang = r1 * TAU;
        var dist = u * spread * (0.4 + 0.6 * r2);
        x = ex + Math.cos(ang) * dist;
        y = ey + Math.sin(ang) * dist - u * rise * 0.2;
        size = effect.size * s * (1 - u) * (0.5 + r3);
        a = (0.5 + 0.5 * Math.sin(u * 12 + r2 * TAU)) * (1 - u);
      } else { // snow: falls across the whole stage
        x = r1 * w + Math.sin(u * TAU * 2 + r2 * TAU) * 20 * s;
        y = -10 + u * (h + 20);
        size = effect.size * s * (0.5 + r3);
        a = 0.85;
      }
      var o = i * 7;
      data[o] = x; data[o + 1] = y; data[o + 2] = Math.max(0.5, size);
      data[o + 3] = col[0]; data[o + 4] = col[1]; data[o + 5] = col[2];
      data[o + 6] = clamp(a * pose.opacity, 0, 1);
    }
    return data;
  }

  function isAdditive(effect) { return effect.type === 'fire' || effect.type === 'sparkle'; }

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

  var VS = 'attribute vec2 a_pos;attribute float a_size;attribute vec4 a_color;uniform vec2 u_res;uniform float u_dpr;varying vec4 v_color;' +
    'void main(){vec2 c=a_pos/u_res*2.0-1.0;gl_Position=vec4(c.x,-c.y,0.0,1.0);gl_PointSize=min(a_size*u_dpr,128.0);v_color=a_color;}';
  var FS = 'precision mediump float;varying vec4 v_color;' +
    'void main(){float r=length(gl_PointCoord-0.5)*2.0;float k=smoothstep(1.0,0.0,r);gl_FragColor=vec4(v_color.rgb*v_color.a*k,v_color.a*k);}';

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
      res: gl.getUniformLocation(prog, 'u_res'), dpr: gl.getUniformLocation(prog, 'u_dpr')
    };
    gl.enable(gl.BLEND);
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
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        for (var b = 0; b < batches.length; b++) {
          var batch = batches[b];
          gl.blendFunc(gl.ONE, batch.additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
          gl.bufferData(gl.ARRAY_BUFFER, batch.data, gl.DYNAMIC_DRAW);
          gl.enableVertexAttribArray(loc.pos);
          gl.vertexAttribPointer(loc.pos, 2, gl.FLOAT, false, 28, 0);
          gl.enableVertexAttribArray(loc.size);
          gl.vertexAttribPointer(loc.size, 1, gl.FLOAT, false, 28, 8);
          gl.enableVertexAttribArray(loc.color);
          gl.vertexAttribPointer(loc.color, 4, gl.FLOAT, false, 28, 12);
          gl.drawArrays(gl.POINTS, 0, batch.data.length / 7);
        }
      }
    };
  }

  // Soft round sprite per quantised colour, for the canvas fallback.
  var sprites = {};
  function sprite(r, g, b) {
    var key = (Math.round(r * 15) << 8) | (Math.round(g * 15) << 4) | Math.round(b * 15);
    if (sprites[key]) return sprites[key];
    var c = document.createElement('canvas');
    c.width = c.height = 64;
    var x = c.getContext('2d');
    var grad = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    var rgb = Math.round(r * 255) + ',' + Math.round(g * 255) + ',' + Math.round(b * 255);
    grad.addColorStop(0, 'rgba(' + rgb + ',1)');
    grad.addColorStop(1, 'rgba(' + rgb + ',0)');
    x.fillStyle = grad;
    x.fillRect(0, 0, 64, 64);
    sprites[key] = c;
    return c;
  }

  function drawParticles2D(ctx, data, additive) {
    ctx.save();
    ctx.globalCompositeOperation = additive ? 'lighter' : 'source-over';
    for (var i = 0; i < data.length; i += 7) {
      var a = data[i + 6];
      if (a <= 0.002) continue;
      var sz = data[i + 2] * 2;
      ctx.globalAlpha = a;
      ctx.drawImage(sprite(data[i + 3], data[i + 4], data[i + 5]), data[i] - sz / 2, data[i + 1] - sz / 2, sz, sz);
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

  function mount(host, config, options) {
    options = options || {};
    var scene = config.scene;
    var assets = config.assets || {};
    var stageHeight = options.stageHeight || '100vh';
    var reduced = !!(g.matchMedia && g.matchMedia('(prefers-reduced-motion: reduce)').matches);

    host.innerHTML = '';
    var track = document.createElement('div');
    track.className = 'mf-track';
    track.style.cssText = 'position:relative;width:100%;';
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
      if (!scene.scroll.reverse) { p = Math.max(p, maxSeen); maxSeen = p; }
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
          var additive = isAdditive(obj.effect);
          if (effectsMode === 'webgl') (obj.effect.layer === 'back' ? back : front).push({ data: data, additive: additive });
          else drawParticles2D(ctx, data, additive);
          continue;
        }

        var frames = imgs[obj.assetId];
        if (!frames || !frames.length) continue;
        var n = frames.length;
        var f = frac(reduced ? 0 : st.phase) * n;
        var idx = Math.floor(f) % n, fr = f - Math.floor(f);
        var a = frames[idx], b = frames[(idx + 1) % n];
        if (!a.complete || !a.naturalWidth) continue;
        var dw = w * obj.widthPct / 100 * st.scale * (mobile ? obj.mobileScale : 1);
        var dh = dw * a.naturalHeight / a.naturalWidth;
        ctx.save();
        ctx.translate(st.x * w / 100, st.y * h / 100);
        ctx.rotate(st.rotation * PI / 180);
        ctx.globalAlpha = st.opacity;
        if (canBlur) ctx.filter = st.blur > 0 ? 'blur(' + st.blur + 'px)' : 'none';
        ctx.drawImage(a, -dw / 2, -dh / 2, dw, dh);
        if (n > 1 && fr > 0.001 && b.complete && b.naturalWidth) {
          ctx.globalAlpha = st.opacity * fr;
          ctx.drawImage(b, -dw / 2, -dh / 2, dw, dh);
        }
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
    mount: mount, evaluate: evaluate, samplePath: samplePath, sampleArray: sampleArray, easings: easings,
    computeParticles: computeParticles, chooseRenderer: chooseRenderer
  };
})(typeof window !== 'undefined' ? window : globalThis);
