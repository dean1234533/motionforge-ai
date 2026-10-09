import { useEffect, useRef, type MouseEvent } from 'react';
import { useSession } from '../lib/session';

const DEMO_PROMPT = 'Make this object orbit upward, rotate gently, and reveal the headline as the visitor scrolls.';

function scrollToSection(event: MouseEvent<HTMLAnchorElement>, id: string) {
  event.preventDefault();
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function Mark() {
  return <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>;
}

function Arrow() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11M11 5l5 5-5 5" /></svg>;
}

function ScrollStudio() {
  const section = useRef<HTMLElement>(null);

  useEffect(() => {
    const node = section.current;
    if (!node) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const rect = node.getBoundingClientRect();
      const distance = Math.max(1, rect.height - window.innerHeight);
      const progress = Math.min(1, Math.max(0, -rect.top / distance));
      node.style.setProperty('--scroll', progress.toFixed(4));
      node.dataset.step = progress < .34 ? '1' : progress < .68 ? '2' : '3';
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <section className="scroll-story" ref={section} aria-labelledby="scroll-title">
      <div className="scroll-sticky">
        <div className="story-copy">
          <span className="kicker">Scroll-directed storytelling</span>
          <h2 id="scroll-title">Motion that follows your visitor’s intent.</h2>
          <div className="story-steps">
            <article className="story-step" data-story="1"><b>01</b><div><h3>Drop in an image</h3><p>Start with your own product, artwork, or cut-out. MotionForge prepares it for animation.</p></div></article>
            <article className="story-step" data-story="2"><b>02</b><div><h3>Describe the movement</h3><p>Use plain language. The motion path, timing, scale, and effects appear instantly.</p></div></article>
            <article className="story-step" data-story="3"><b>03</b><div><h3>Ship production code</h3><p>Export a lightweight, responsive experience that scrubs smoothly in both directions.</p></div></article>
          </div>
        </div>

        <div className="studio-shell" aria-label="Interactive scroll animation preview">
          <div className="studio-topbar"><span className="studio-dot" /><span>aurora-launch.mf</span><span className="studio-saved">Saved</span></div>
          <div className="studio-canvas">
            <div className="canvas-grid" />
            <svg className="motion-path" viewBox="0 0 600 540" preserveAspectRatio="none" aria-hidden="true">
              <path d="M88 448 C 180 405, 180 180, 305 268 S 430 400, 525 90" />
              <circle cx="88" cy="448" r="5" /><circle cx="305" cy="268" r="5" /><circle cx="525" cy="90" r="5" />
            </svg>
            <div className="orbit-object"><span className="orbit-core" /><i /><i /></div>
            <div className="canvas-label"><span>LIVE</span><strong>Scroll to direct the scene</strong></div>
            <div className="progress-rail"><i /></div>
          </div>
          <div className="studio-prompt"><span className="prompt-spark">✦</span><span>{DEMO_PROMPT}</span><button type="button" aria-label="Send prompt">↑</button></div>
        </div>
      </div>
    </section>
  );
}

const WORKS = [
  { className: 'work-orbit', number: '01', title: 'Orbital product reveal', tag: 'Product launch', prompt: 'Orbit upward and catch the light.' },
  { className: 'work-fold', number: '02', title: 'Folded light study', tag: 'Brand story', prompt: 'Unfold softly as the page moves.' },
  { className: 'work-type', number: '03', title: 'Kinetic typography', tag: 'Editorial', prompt: 'Reveal each line with momentum.' },
];

const FAQ = [
  ['Do I need to write code?', 'No. Upload an image, describe the motion, and fine-tune it visually. MotionForge writes the production code for you.'],
  ['Will exports keep working without MotionForge?', 'Yes. Standalone exports include their frames and run without an account, API key, or MotionForge subscription.'],
  ['Can I use it with my existing website?', 'Yes. Export an embed, standalone HTML, React component, Webflow embed, or WordPress block.'],
  ['Is the output accessible?', 'Yes. Exports respect reduced-motion preferences and fall back to a composed still frame.'],
];

export function Landing() {
  const { user } = useSession();
  const destination = user ? '#/new' : '#/editor?auto=robin';

  return (
    <div className="landing landing-v2">
      <header className="landing-nav">
        <a className="brand brand-new" href="#/" aria-label="MotionForge AI home"><Mark /><span>MotionForge</span><em>AI</em></a>
        <nav aria-label="Main navigation"><a href="#showcase" onClick={(event) => scrollToSection(event, 'showcase')}>Showcase</a><a href="#features" onClick={(event) => scrollToSection(event, 'features')}>Features</a><a href="#/docs">Docs</a></nav>
        <div className="nav-actions"><a className="nav-login" href={user ? '#/dashboard' : '#/login'}>{user ? 'Projects' : 'Log in'}</a><a className="btn primary nav-cta" href={user ? '#/new' : '#/login'}>{user ? 'New project' : 'Start creating'} <Arrow /></a></div>
      </header>

      <main>
        <section className="new-hero">
          <div className="hero-glow" />
          <div className="hero-copy">
            <div className="eyebrow"><span>✦</span> AI motion studio for the web</div>
            <h1>Make the web <em>move.</em></h1>
            <p>Turn a single image and a simple idea into cinematic, scroll-driven experiences—ready to ship anywhere.</p>
            <div className="hero-actions"><a className="btn primary hero-primary" href={destination}>Create an animation <Arrow /></a><a className="text-link" href="#showcase" onClick={(event) => scrollToSection(event, 'showcase')}>Explore the showcase <span>↓</span></a></div>
            <div className="hero-meta"><span>No code required</span><span>Export anywhere</span><span>Free to start</span></div>
          </div>
          <div className="hero-art" aria-label="A luminous glass bird in flight">
            <img src={`${import.meta.env.BASE_URL}assets/motionforge-glass-bird.webp`} alt="A luminous blue and amber glass bird in flight" />
            <div className="hero-orbit hero-orbit-one" /><div className="hero-orbit hero-orbit-two" />
            <div className="floating-chip chip-one"><i /> SCROLL-LINKED</div><div className="floating-chip chip-two"><span>60</span> FPS</div>
          </div>
          <a className="scroll-cue" href="#showcase" onClick={(event) => scrollToSection(event, 'showcase')}><span>Scroll to explore</span><i /></a>
        </section>

        <section className="trust-row" aria-label="Product highlights"><p>FROM STILL FRAME <span>→</span> LIVING STORY</p><div /><p><b>01</b> PROMPT</p><p><b>∞</b> POSSIBILITIES</p><p><b>0</b> LOCK-IN</p></section>
        <div id="showcase"><ScrollStudio /></div>

        <section className="work-section" aria-labelledby="work-heading">
          <header className="section-heading"><div><span className="kicker">Made with MotionForge</span><h2 id="work-heading">One still. Infinite directions.</h2></div><p>Every scene below begins with one image and a sentence. The rest is motion, made tangible.</p></header>
          <div className="work-grid">
            {WORKS.map((work) => <a className={`work-card ${work.className}`} href={`#/editor?prompt=${encodeURIComponent(work.prompt)}`} key={work.title}>
              <div className="work-visual"><div className="visual-shape"><i /><i /><i /></div><span className="work-number">{work.number}</span><span className="work-open">↗</span></div>
              <div className="work-caption"><div><span>{work.tag}</span><h3>{work.title}</h3></div><p>“{work.prompt}”</p></div>
            </a>)}
          </div>
        </section>

        <section className="feature-section" id="features" aria-labelledby="features-heading">
          <div className="feature-intro"><span className="kicker">Built for the final 10%</span><h2 id="features-heading">The control of code.<br />The speed of a prompt.</h2><p>Great motion is more than an entrance effect. Shape the whole performance, then hand off clean production code.</p><a href="#/docs" className="text-link">Explore every feature <Arrow /></a></div>
          <div className="feature-bento">
            <article className="feature-card feature-path"><span className="feature-icon">⌁</span><div><h3>Visual path editor</h3><p>Direct every curve with editable waypoints and precision easing.</p></div><svg viewBox="0 0 440 160" aria-hidden="true"><path d="M20 130 C110 140 108 28 204 54 S330 150 420 20" /><circle cx="20" cy="130" r="5" /><circle cx="204" cy="54" r="5" /><circle cx="420" cy="20" r="5" /></svg></article>
            <article className="feature-card feature-code"><span className="feature-icon">&lt;/&gt;</span><div><h3>Clean export</h3><p>React, HTML, Webflow, or WordPress. No black box and no runtime lock-in.</p></div><pre><code><span>const</span> scene = forge({'{'}<br />&nbsp;&nbsp;scrub: <b>true</b>,<br />&nbsp;&nbsp;easing: <i>'cinematic'</i><br />{'}'});</code></pre></article>
            <article className="feature-card feature-effects"><span className="feature-icon">✦</span><div><h3>Layered effects</h3><p>Light, trails, particles, blur, and depth—composed in real time.</p></div><div className="effect-cloud"><i /><i /><i /><i /><i /></div></article>
            <article className="feature-card feature-speed"><div className="speed-ring"><strong>60</strong><span>FPS</span></div><div><h3>Made to feel fast</h3><p>GPU-accelerated rendering, responsive sizing, and reduced-motion support.</p></div></article>
          </div>
        </section>

        <section className="export-strip"><span className="kicker">Publish your way</span><div className="export-marquee"><span>HTML</span><i /><span>React</span><i /><span>Webflow</span><i /><span>WordPress</span><i /><span>ZIP</span><i /><span>Embed</span></div></section>
        <section className="faq-section" aria-labelledby="faq-heading"><div className="faq-title"><span className="kicker">Good to know</span><h2 id="faq-heading">Questions,<br />answered.</h2></div><div className="faq-list">{FAQ.map(([q, a], index) => <details key={q}><summary><span>0{index + 1}</span>{q}<i>+</i></summary><p>{a}</p></details>)}</div></section>
        <section className="final-cta"><div className="cta-orb" /><span className="kicker">Your image is only the beginning</span><h2>Give your ideas<br /><em>somewhere to go.</em></h2><p>Build your first scroll-driven scene in minutes.</p><a className="btn cta-button" href={destination}>Open MotionForge <Arrow /></a></section>
      </main>

      <footer className="landing-footer"><a className="brand brand-new" href="#/"><Mark /><span>MotionForge</span><em>AI</em></a><p>Still images, set in motion.</p><nav><a href="#/docs">Docs</a><a href="#/login">Log in</a><a href="mailto:hello@motionforge.ai">Contact</a></nav><small>© {new Date().getFullYear()} MotionForge AI</small></footer>
    </div>
  );
}
