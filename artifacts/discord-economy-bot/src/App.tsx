import { type ReactNode, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ArrowUpRight,
  Bot,
  Check,
  ChevronDown,
  CircleCheck,
  Clipboard,
  Coins,
  Database,
  Gamepad2,
  KeyRound,
  LockKeyhole,
  MessageSquare,
  ServerCog,
  ShieldCheck,
  Trophy,
  Users,
  WalletCards,
} from 'lucide-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

const queryClient = new QueryClient();

function Home() {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyStatus = async () => {
    const snapshot = 'Discord Economy Bot — configured, running, persistent storage enabled';
    try {
      await navigator.clipboard.writeText(snapshot);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="status-app">
      <div className="top-rule" />
      <div className="page-shell">
        <header className="site-header" data-testid="header-site">
          <a className="brand" href="#top" data-testid="link-home">
            <span className="brand-mark" aria-hidden="true"><span>DE</span></span>
            <span>discord economy</span>
          </a>
          <nav className="nav-links" aria-label="Page sections">
            <a href="#status" data-testid="link-status">status</a>
            <a href="#capabilities" data-testid="link-capabilities">capabilities</a>
            <a href="#runtime" data-testid="link-runtime">runtime</a>
          </nav>
          <button className="copy-button" type="button" onClick={copyStatus} data-testid="button-copy-status">
            {copied ? <Check size={13} aria-hidden="true" /> : <Clipboard size={13} aria-hidden="true" />}
            <span>{copied ? 'copied' : 'copy status'}</span>
          </button>
        </header>

        <main id="top">
          <section className="hero" aria-labelledby="hero-title">
            <div>
              <p className="eyebrow">deployment / worker 01</p>
              <h1 id="hero-title">The community economy stays <em>on.</em></h1>
              <p className="hero-copy">
                A dependable Discord utility for the everyday economy:
                <strong> balances, rewards, transfers, leaderboards, and games</strong> —
                available whenever the server is.
              </p>
            </div>

            <aside className="config-card" aria-label="Deployment status">
              <div className="config-heading">
                <span className="mono-label">live configuration</span>
                <span className="led">nominal</span>
              </div>
              <div className="config-status">
                <strong>Operational</strong>
                <span>background worker</span>
              </div>
              <ul className="config-list">
                <li><CircleCheck size={14} aria-hidden="true" /> Bot identity configured</li>
                <li><CircleCheck size={14} aria-hidden="true" /> Worker process running</li>
                <li><CircleCheck size={14} aria-hidden="true" /> Economy storage is durable</li>
              </ul>
            </aside>
          </section>

          <section className="section" id="status" aria-labelledby="status-title">
            <div className="section-heading">
              <div>
                <p className="section-kicker">01 / system posture</p>
                <h2 id="status-title">Three things are true.</h2>
              </div>
              <p className="section-note">No dashboards to decode. The important parts are clear at a glance.</p>
            </div>

            <div className="status-grid">
              <article className="status-card featured" data-testid="card-worker-status">
                <div className="card-topline">
                  <span className="card-label">01 — process</span>
                  <span className="status-icon"><ServerCog size={16} aria-hidden="true" /></span>
                </div>
                <div>
                  <h3>Running as a background worker.</h3>
                  <p className="card-detail">The bot stays available without a browser tab or a manual launch.</p>
                </div>
              </article>

              <article className="status-card" data-testid="card-storage-status">
                <div className="card-topline">
                  <span className="card-label">02 — storage</span>
                  <span className="status-icon"><Database size={16} aria-hidden="true" /></span>
                </div>
                <h3>Persistent SQLite economy.</h3>
                <p className="card-detail">Balances and rewards live in a durable local data file, not temporary memory.</p>
                <span className="card-mark"><Check size={13} aria-hidden="true" /> survives restarts</span>
              </article>

              <article className="status-card" data-testid="card-credentials-status">
                <div className="card-topline">
                  <span className="card-label">03 — access</span>
                  <span className="status-icon"><LockKeyhole size={16} aria-hidden="true" /></span>
                </div>
                <h3>Credentials stay private.</h3>
                <p className="card-detail">The deployment confirms configuration without exposing tokens or secrets in the UI.</p>
                <span className="card-mark"><ShieldCheck size={13} aria-hidden="true" /> protected by design</span>
              </article>
            </div>
          </section>

          <section className="section" id="capabilities" aria-labelledby="capabilities-title">
            <div className="capability-layout">
              <div className="capability-intro">
                <p className="section-kicker">02 / economy surface</p>
                <h2 id="capabilities-title"><span>Everything your server expects.</span></h2>
                <p>One worker keeps the community loop moving, from a first balance check to a late-night leaderboard run.</p>
              </div>
              <div className="capability-list" role="list" aria-label="Enabled bot capabilities">
                <div className="capability-row" role="listitem" data-testid="row-capability-balances">
                  <span className="capability-name"><WalletCards size={16} aria-hidden="true" /> Balances</span>
                  <span className="capability-detail">wallets &amp; account state</span>
                  <span className="enabled-tag"><Check size={13} aria-hidden="true" /> enabled</span>
                </div>
                <div className="capability-row" role="listitem" data-testid="row-capability-rewards">
                  <span className="capability-name"><Coins size={16} aria-hidden="true" /> Rewards</span>
                  <span className="capability-detail">earn, claim, and collect</span>
                  <span className="enabled-tag"><Check size={13} aria-hidden="true" /> enabled</span>
                </div>
                <div className="capability-row" role="listitem" data-testid="row-capability-transfers">
                  <span className="capability-name"><Users size={16} aria-hidden="true" /> Transfers</span>
                  <span className="capability-detail">member-to-member economy</span>
                  <span className="enabled-tag"><Check size={13} aria-hidden="true" /> enabled</span>
                </div>
                <div className="capability-row" role="listitem" data-testid="row-capability-leaderboards">
                  <span className="capability-name"><Trophy size={16} aria-hidden="true" /> Leaderboards</span>
                  <span className="capability-detail">friendly competition</span>
                  <span className="enabled-tag"><Check size={13} aria-hidden="true" /> enabled</span>
                </div>
                <div className="capability-row" role="listitem" data-testid="row-capability-games">
                  <span className="capability-name"><Gamepad2 size={16} aria-hidden="true" /> Interactive games</span>
                  <span className="capability-detail">small stakes, good chaos</span>
                  <span className="enabled-tag"><Check size={13} aria-hidden="true" /> enabled</span>
                </div>
              </div>
            </div>
          </section>

          <section className="section runtime" id="runtime" aria-labelledby="runtime-title">
            <div className="section-heading">
              <div>
                <p className="section-kicker">03 / runtime contract</p>
                <h2 id="runtime-title">Set it once. Let the worker handle the rest.</h2>
              </div>
              <p className="section-note">A small footprint, an unbroken economy.</p>
            </div>
            <div className="runtime-grid">
              <div className="runtime-rail" aria-label="Deployment sequence">
                <div className="runtime-step">
                  <span className="step-node"><KeyRound size={13} aria-hidden="true" /></span>
                  <div><h3>Configured</h3><p>Bot identity and runtime settings are in place.</p></div>
                </div>
                <div className="runtime-step">
                  <span className="step-node"><Bot size={14} aria-hidden="true" /></span>
                  <div><h3>Worker started</h3><p>The process runs continuously in the background.</p></div>
                </div>
                <div className="runtime-step">
                  <span className="step-node"><MessageSquare size={14} aria-hidden="true" /></span>
                  <div><h3>Community ready</h3><p>Commands are available when your members need them.</p></div>
                </div>
              </div>
              <div className="contract-card">
                <p className="mono-label">the promise</p>
                <h3>Useful utility, quiet infrastructure.</h3>
                <p>Economy state is kept close to the worker in SQLite. The interface reports posture, not private internals.</p>
                <div className="contract-code" aria-label="Storage configuration">
                  <span>storage / economy.sqlite</span>
                  <Database size={15} aria-hidden="true" />
                </div>
                <button
                  className="detail-toggle"
                  type="button"
                  aria-expanded={detailsOpen}
                  onClick={() => setDetailsOpen((isOpen) => !isOpen)}
                  data-testid="button-toggle-contract"
                >
                  <span>{detailsOpen ? 'hide worker contract' : 'show worker contract'}</span>
                  <ChevronDown size={14} aria-hidden="true" />
                </button>
                <div className={`contract-details${detailsOpen ? ' open' : ''}`} aria-hidden={!detailsOpen}>
                  <p>Commands read and write the same persistent economy file, so a process restart does not reset community progress.</p>
                </div>
              </div>
            </div>
          </section>
        </main>

        <footer className="site-footer" data-testid="footer-site">
          <span className="footer-mark">discord economy / worker 01</span>
          <div className="footer-copy">
            <span>configured for continuity</span>
            <span>credentials never displayed</span>
            <a href="#top" data-testid="link-back-to-top">back to top <ArrowUpRight size={12} aria-hidden="true" /></a>
          </div>
        </footer>
      </div>
    </div>
  );
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Home} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;