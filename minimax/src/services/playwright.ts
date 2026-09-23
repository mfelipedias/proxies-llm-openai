/*
 * File: playwright.ts
 * Project: minimaxproxy
 *
 * Arquitetura "bridge" (igual ao porte glm/): o agent.minimax.io assina cada
 * request com `x-signature` (cobre o CORPO) + `x-timestamp`, calculados por um
 * interceptor do front-end. Replicar isso em Node é inviável. Então deixamos o
 * PRÓPRIO app assinar/enviar: injetamos o prompt no input da UI e um hook de
 * `window.fetch` faz o "tee" do stream SSE de `/session/<id>/message` de volta
 * para o Node via um binding exposto.
 *
 * Login: OAuth2 (Ory) com captcha → feito manualmente uma vez (`npm run
 * login:manual`); a sessão persiste no perfil `minimax_profiles/<id>`.
 */
import { chromium, firefox, webkit, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import { MinimaxAccount } from '../core/accounts.ts';
import { config } from '../core/config.ts';

export type BrowserType = 'chromium' | 'firefox' | 'webkit' | 'chrome' | 'edge';

const BASE_URL = config.minimax.baseUrl; // https://agent.minimax.io

let context: BrowserContext | null = null;
export let activePage: Page | null = null;
export function getActivePage(): Page | null { return activePage; }

const accountContexts = new Map<string, BrowserContext>();
const accountPages = new Map<string, Page>();

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Auto-recuperação: locks órfãos, liveness e estado de "página suspeita"
// ---------------------------------------------------------------------------

/** Erro de sessão (deslogado / não-recuperável por re-seed). Sinaliza ao chat.ts
 *  que NÃO adianta retentar a mesma conta sem re-login manual. */
export class MinimaxSessionError extends Error {
  readonly accountId: string;
  constructor(accountId: string) {
    super(`MiniMax: conta "${accountId}" sem sessão logada (re-seed falhou). Rode \`npm run login:manual\` + \`npm run session:export\`.`);
    this.name = 'MinimaxSessionError';
    this.accountId = accountId;
  }
}

// Páginas que falharam (timeout sem dados / erro de envio) e devem ser
// relançadas antes do próximo uso. WeakSet: não segura a página viva.
const suspectPages = new WeakSet<Page>();

/**
 * Remove arquivos de lock órfãos (`SingletonLock`, `SingletonCookie`,
 * `SingletonSocket`) de um profile persistente. Quando o Node reinicia/crasha
 * sem fechar o Chromium, o profile fica travado e o launch seguinte falha com
 * "profile appears to be in use". Limpar destrava. Só é seguro quando NÃO há
 * Chromium vivo no profile (antes do 1º launch ou após falha de launch por lock).
 */
function clearProfileLocks(profilePath: string): void {
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.rmSync(path.join(profilePath, name), { force: true }); } catch { /* pode não existir — ok */ }
  }
}

/** Heurística: o erro de launch foi causado por lock órfão do profile? */
function isProfileLockError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /profile appears to be in use|SingletonLock|ProcessSingleton|locked the profile/i.test(msg);
}

/** launchPersistentContext com 1 retry após limpar lock órfão. */
async function launchPersistentWithRecovery(engine: any, profilePath: string, opts: any): Promise<BrowserContext> {
  try {
    return await engine.launchPersistentContext(profilePath, opts);
  } catch (err) {
    if (!isProfileLockError(err)) throw err;
    console.warn(`[Playwright] Profile ${profilePath} travado por lock órfão; limpando e retentando.`);
    clearProfileLocks(profilePath);
    return await engine.launchPersistentContext(profilePath, opts);
  }
}

/** Página viva e utilizável? (objeto existe e não foi fechada) */
function isPageUsable(page: Page | null | undefined): page is Page {
  return !!page && !page.isClosed() && !suspectPages.has(page);
}

// ---------------------------------------------------------------------------
// Bridge: hook de window.fetch + tee do SSE de /session/<id>/message
// ---------------------------------------------------------------------------
type BridgeMsg = { t: 'chunk'; d: string } | { t: 'done' } | { t: 'error'; d: string };
const pageSinks = new Map<Page, (msg: BridgeMsg) => void>();
const bridgeInstalled = new WeakSet<BrowserContext>();

async function installBridge(ctx: BrowserContext) {
  if (bridgeInstalled.has(ctx)) return;
  bridgeInstalled.add(ctx);

  await ctx.exposeBinding('__mmBridge', (source, msg: BridgeMsg) => {
    const sink = pageSinks.get(source.page);
    if (sink) sink(msg);
  });

  await ctx.addInitScript(() => {
    const w = window as any;
    if (w.__mmHooked) return;
    w.__mmHooked = true;
    const orig = window.fetch;
    window.fetch = async (...args: any[]) => {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
      const res = await orig.apply(window, args as any);
      try {
        if (url && /\/session\/[^/]+\/message/.test(url) && (res as any).body) {
          const reader = (res as Response).clone().body!.getReader();
          const dec = new TextDecoder();
          (async () => {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                w.__mmBridge({ t: 'chunk', d: dec.decode(value, { stream: true }) });
              }
              w.__mmBridge({ t: 'done' });
            } catch (e) {
              w.__mmBridge({ t: 'error', d: String(e) });
            }
          })();
        }
      } catch { /* ignore */ }
      return res;
    };
  });
}

// Botões de fechar de modais/popups (o popup "Download desktop" aparece com
// alguns segundos de atraso, depois do load).
const CLOSE_SELECTORS = [
  '[data-testid="desktop-download-popup-close"]',
  'button[aria-label="Close"]',
  'button[aria-label="close"]',
  '[data-testid*="close" i]',
  'button[class*="close" i]',
];

/** Poll por ~3s fechando qualquer modal/popup assim que ele aparecer.
 *  Sai na primeira dispensa (o segundo dismissModal antes da injeção cobre o
 *  popup atrasado) — antes eram 6 rodadas fixas de 1s em TODO request. */
async function dismissModal(page: Page, rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    let clicked = false;
    for (const sel of CLOSE_SELECTORS) {
      const els = await page.$$(sel).catch(() => []);
      for (const b of els) {
        if (await b.isVisible().catch(() => false)) {
          await b.click({ timeout: 1500 }).catch(() => {});
          clicked = true;
          console.log('[bridge] modal/popup fechado via', sel);
        }
      }
    }
    await page.keyboard.press('Escape').catch(() => {});
    if (clicked) break; // fechou algo → seguir; popups atrasados são cobertos pela 2ª passada
    await sleep(1000);
  }
}

const INPUT_SEL = 'textarea, [contenteditable="true"]';

// ---------------------------------------------------------------------------
// Aquisição de página saudável (liveness + relaunch + re-seed de login)
// ---------------------------------------------------------------------------

/** Fecha só o contexto global (sem tocar nos contextos por-conta). */
async function closeGlobalContext(): Promise<void> {
  if (context) {
    await context.close().catch(() => {});
    context = null;
    activePage = null;
  }
}

/** Relança o contexto/página de uma conta (ou o global) e devolve a página viva. */
async function relaunchPage(accountId?: string): Promise<Page> {
  const isGlobal = !accountId || accountId === 'global';
  if (isGlobal) {
    await closeGlobalContext();
    await initPlaywright(config.browser.headless);
    if (!activePage) throw new Error('Falha ao relançar contexto global');
    return activePage;
  }
  await closePlaywrightForAccount(accountId!);
  const { getAccountCredentials } = await import('../core/accounts.ts');
  const creds = getAccountCredentials(accountId!);
  if (!creds) throw new Error(`Conta ${accountId} sem credenciais para relançar`);
  await initPlaywrightForAccount(creds, config.browser.headless);
  const pg = accountPages.get(accountId!);
  if (!pg) throw new Error(`Falha ao relançar contexto da conta ${accountId}`);
  return pg;
}

/** Devolve uma página viva para o account (inicializa/relança se preciso).
 *  Conta nomeada sem credenciais cai pro perfil global (_default). */
async function acquireHealthyPage(accountId?: string): Promise<Page> {
  let isGlobal = !accountId || accountId === 'global';
  if (!isGlobal) {
    const { getAccountCredentials } = await import('../core/accounts.ts');
    if (!getAccountCredentials(accountId!)) { isGlobal = true; accountId = undefined; }
  }
  const page = isGlobal ? activePage : accountPages.get(accountId!);
  if (isPageUsable(page)) return page;
  if (page) console.warn(`[bridge] página inutilizável (fechada/suspeita) p/ ${isGlobal ? 'global' : accountId}; relançando...`);
  return relaunchPage(isGlobal ? undefined : accountId);
}

/** Garante sessão logada: tenta re-seed em runtime; erro claro se não recuperar. */
async function ensureLoggedIn(page: Page, accountId?: string): Promise<void> {
  if (await hasSession(page)) return;
  console.warn(`[bridge] sessão ausente p/ ${accountId ?? 'global'}; tentando re-seed de minimax_session.json...`);
  const seeded = await seedSessionIfNeeded(page.context(), page);
  if (seeded || (await hasSession(page))) {
    console.log('[bridge] sessão recuperada via re-seed em runtime.');
    return;
  }
  throw new MinimaxSessionError(accountId ?? 'global');
}

/** Navega para uma conversa nova; se o browser morreu, relança 1x e retenta. */
async function navigateFreshConversation(page: Page, accountId?: string): Promise<Page> {
  let pg = page;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      console.log('[bridge] navegando para nova conversa...');
      await pg.goto(`${BASE_URL}/`, { waitUntil: 'commit', timeout: 30000 }).catch(() => {});
      await pg.waitForSelector(INPUT_SEL, { timeout: 45000 });
      await dismissModal(pg);
      await pg.waitForSelector(INPUT_SEL, { timeout: 10000 });
      console.log('[bridge] input encontrado.');
      return pg;
    } catch (err: any) {
      const dead = pg.isClosed() || /Target closed|has been closed|crashed|browser has disconnected|Target page, context or browser/i.test(String(err?.message));
      if (attempt === 0 && dead) {
        console.warn('[bridge] navegação falhou com browser morto; relançando e retentando...', err?.message);
        suspectPages.add(pg);
        pg = await relaunchPage(accountId);
        continue;
      }
      throw err;
    }
  }
  return pg;
}

/**
 * Dispara um completion deixando o app do MiniMax assinar/enviar e devolve um
 * ReadableStream com o SSE cru (formato MiniMax: linhas `data:{...}`).
 * O `model` é informativo: como a assinatura cobre o corpo, o modelo efetivo é
 * o selecionado na UI (default MiniMax-M3). O prompt É injetado (a assinatura
 * cobre o corpo, então precisa ser o app a montar a request).
 */
// Test-only: roteiro de linhas SSE (formato MiniMax) que o mock da bridge emite
// quando TEST_MOCK_PLAYWRIGHT está ativo. Permite testar o pipeline completo
// do chat.ts (parser de tool-calls, streaming/non-streaming) sem browser.
let testBridgeScript: string[] | null = null;
export function __setTestBridgeScript(lines: string[] | null) { testBridgeScript = lines; }

export async function createBridgeStream(
  prompt: string,
  accountId?: string,
): Promise<{ stream: ReadableStream; controller: AbortController; uiSessionId: string; accountId: string }> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    const lines = testBridgeScript ?? [
      'data:{"type":6,"agent_message_chunk":{"msg_content":"Hello mock","finish":true,"finish_reason":"stop"}}',
    ];
    const mockController = new AbortController();
    const mockStream = new ReadableStream({
      start(c) {
        const enc = new TextEncoder();
        for (const l of lines) c.enqueue(enc.encode(l + '\n'));
        c.close();
      },
    });
    return { stream: mockStream, controller: mockController, uiSessionId: 'mock', accountId: accountId ?? 'global' };
  }
  // Garante uma página viva (relança se fechada/suspeita) e logada (re-seed em
  // runtime; erro claro se não der). Isto elimina o sintoma "parou": antes,
  // quando a aba morria ou a sessão expirava, todo request ficava 60s no
  // timeout sem dados e voltava vazio.
  let pg = await acquireHealthyPage(accountId);
  await ensureLoggedIn(pg, accountId);

  // Estado limpo: nova conversa a cada request (proxy stateless). Resiliente a
  // browser morto: relança 1x e retenta a navegação.
  pg = await navigateFreshConversation(pg, accountId);

  const controller = new AbortController();
  let gotData = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const stream = new ReadableStream({
    start(c) {
      const enc = new TextEncoder();
      let closed = false;
      const finish = (fn: () => void) => { closed = true; if (idleTimer) clearTimeout(idleTimer); pageSinks.delete(pg); try { fn(); } catch { /* noop */ } };
      // Watchdog em DUAS fases (não só no primeiro chunk): 60s para o primeiro
      // dado (envio falhou?) e 120s de inatividade ENTRE chunks (aba/websocket
      // travou no meio do stream — antes isso pendurava o request para sempre).
      // Nos dois casos marca a página suspeita → o próximo request relança o
      // contexto (auto-heal) em vez de repetir o travamento.
      const armIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (closed) return;
          suspectPages.add(pg);
          finish(() => c.error(new Error(gotData
            ? 'MiniMax: stream travado (sem novos dados do app há 120s)'
            : 'MiniMax: timeout sem resposta do app (envio falhou?)')));
        }, gotData ? 120000 : 60000);
      };
      pageSinks.set(pg, (msg) => {
        if (closed) return;
        if (msg.t === 'chunk') {
          gotData = true;
          armIdleTimer();
          c.enqueue(enc.encode(msg.d));
        } else if (msg.t === 'done') {
          finish(() => c.close());
        } else {
          finish(() => c.error(new Error(msg.d)));
        }
      });
      controller.signal.addEventListener('abort', () => finish(() => c.close()));
      armIdleTimer();
    },
  });

  try {
    // Fecha o popup "Download desktop" que costuma aparecer atrasado.
    await dismissModal(pg, 2);

    // Foca o input e insere o texto via insertText (CDP): trata multi-linha,
    // dispara o evento `input` (React vê), sem submeter por newline.
    const inputEl = (await pg.$('textarea')) || (await pg.$('[contenteditable="true"]'));
    if (!inputEl) throw new Error('input não encontrado para injeção');
    await inputEl.click().catch(() => {});
    await sleep(150);
    await pg.keyboard.insertText(prompt);
    await sleep(500);
    console.log('[bridge] prompt injetado, enviando...');

    // Envia: tenta o botão oficial (habilitado após o texto); senão Enter.
    let sent = false;
    for (const sel of ['[data-testid="send-button"]', 'button[type="submit"]', 'button[aria-label="Send message"]', 'button[data-testid*="send" i]', 'form button:has(svg)']) {
      const b = await pg.$(sel).catch(() => null);
      if (b && await b.isEnabled().catch(() => false) && await b.isVisible().catch(() => false)) {
        await b.click().catch(() => {});
        sent = true;
        console.log('[bridge] enviado via botão', sel);
        break;
      }
    }
    if (!sent) {
      await inputEl.focus().catch(() => {});
      await pg.keyboard.press('Enter');
      console.log('[bridge] enviado via Enter');
    }
  } catch (err) {
    // Falhou ANTES de enviar, com o stream já construído: aborta para limpar o
    // watchdog e o pageSink agora (sem isso eles só seriam limpos quando o
    // timer de 60s disparasse) e marca a página p/ relançar no próximo request.
    suspectPages.add(pg);
    controller.abort();
    throw err;
  }

  return { stream, controller, uiSessionId: '', accountId: accountId ?? 'global' };
}

// ---------------------------------------------------------------------------
// Launch / contexto
// ---------------------------------------------------------------------------
function resolveEngine(browserType: BrowserType): { engine: any; channel?: string } {
  switch (browserType) {
    case 'firefox': return { engine: firefox };
    case 'webkit': return { engine: webkit };
    case 'chrome': return { engine: chromium, channel: 'chrome' };
    case 'edge': return { engine: chromium, channel: 'msedge' };
    default: return { engine: chromium };
  }
}

const LAUNCH_OPTS = {
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
};

// Cookies de analytics/telemetria que casariam com "session|token" e dariam
// falso positivo de login (deslogado parecendo logado → re-seed nunca dispara).
const ANALYTICS_COOKIE_RE = /^(_ga|_gid|_gat|_fbp|_fbc|hm_|hjsession|_hj|amplitude|mixpanel|sensors|ajs_|_clck|_clsk)/i;

async function hasSession(page: Page): Promise<boolean> {
  try {
    const cookies = await page.context().cookies();
    // Sinal forte: cookie de sessão do Ory (o login do MiniMax é OAuth2/Ory).
    if (cookies.some(c => /^ory_session/i.test(c.name) && !!c.value)) return true;
    // Fallback genérico, excluindo analytics.
    return cookies.some(c => !ANALYTICS_COOKIE_RE.test(c.name) && /session|sess|token/i.test(c.name) && !!c.value);
  } catch { return false; }
}

/**
 * Semeia a sessão logada a partir de `minimax_session.json` (cookies +
 * localStorage exportados via `npm run export-session`). Portável e
 * cross-OS: os cookies são re-encriptados pelo Chromium do host de destino
 * via `addCookies`, então um perfil VAZIO em Docker/Linux fica logado sem
 * refazer o login manual (que exige captcha/GUI).
 *
 * Só roda quando o perfil ainda não tem sessão. Retorna `true` se semeou.
 */
async function seedSessionIfNeeded(ctx: BrowserContext, page: Page): Promise<boolean> {
  if (await hasSession(page)) return false;
  const seedPath = path.resolve('minimax_session.json');
  if (!fs.existsSync(seedPath)) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    const rawCookies: any[] = Array.isArray(raw.cookies) ? raw.cookies : [];
    const ls: Record<string, string> = raw.localStorage && typeof raw.localStorage === 'object' ? raw.localStorage : {};
    if (!rawCookies.length && !Object.keys(ls).length) return false;

    // Normaliza para os campos que `addCookies` aceita (descarta extras).
    const cookies = rawCookies.map(c => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path,
      expires: typeof c.expires === 'number' ? c.expires : -1,
      httpOnly: !!c.httpOnly, secure: !!c.secure,
      sameSite: ['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax',
    }));
    if (cookies.length) await ctx.addCookies(cookies as any);

    // localStorage precisa ser setado na própria origin.
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    const lsEntries = Object.entries(ls);
    if (lsEntries.length) {
      await page.evaluate((entries) => {
        for (const [k, v] of entries) { try { localStorage.setItem(k, v as string); } catch { /* noop */ } }
      }, lsEntries).catch(() => {});
    }
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});

    const ok = await hasSession(page);
    console.log(`[Playwright] Sessão semeada de minimax_session.json (cookies=${cookies.length}, ls=${lsEntries.length}) → logado=${ok}.`);
    return ok;
  } catch (e: any) {
    console.warn('[Playwright] Falha ao semear sessão de minimax_session.json:', e.message);
    return false;
  }
}

export async function initPlaywright(headless = true, browserType: BrowserType = 'chromium') {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (context) return;

  const profilePath = path.resolve('minimax_profiles', '_default');
  const { engine, channel } = resolveEngine(browserType);
  console.log(`[Playwright] Launching ${browserType} (perfil _default)...`);

  const ctx: BrowserContext = await launchPersistentWithRecovery(engine, profilePath, { headless, channel, ...LAUNCH_OPTS });
  context = ctx;
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  await installBridge(ctx);

  activePage = await ctx.newPage();
  await activePage.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  if (!(await hasSession(activePage))) {
    const seeded = await seedSessionIfNeeded(ctx, activePage);
    if (!seeded) console.warn('[Playwright] Sem sessão logada no perfil _default e sem minimax_session.json válido. Rode `npm run login:manual` + `npm run export-session`.');
  }
}

export async function initPlaywrightForAccount(account: MinimaxAccount, headless = true, browserType: BrowserType = 'chromium') {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (accountPages.has(account.id)) return;

  const profilePath = path.resolve('minimax_profiles', account.id);
  const { engine, channel } = resolveEngine(browserType);
  console.log(`[Playwright] Launching ${browserType} para conta ${account.email}...`);

  const acctContext = await launchPersistentWithRecovery(engine, profilePath, { headless, channel, ...LAUNCH_OPTS });
  await acctContext.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  await installBridge(acctContext);

  const acctPage = await acctContext.newPage();
  accountContexts.set(account.id, acctContext);
  accountPages.set(account.id, acctPage);

  await acctPage.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  if (!(await hasSession(acctPage))) {
    const seeded = await seedSessionIfNeeded(acctContext, acctPage);
    if (!seeded) console.warn(`[Playwright] Conta ${account.email} sem sessão. Rode \`npm run login:manual ${account.id}\`.`);
  }
}

export async function launchManualLoginAccount(accountId: string, browserType: BrowserType = 'chromium'): Promise<{ context: BrowserContext, page: Page }> {
  const profilePath = path.resolve('minimax_profiles', accountId);
  const { engine, channel } = resolveEngine(browserType);
  const acctContext = await launchPersistentWithRecovery(engine, profilePath, { headless: false, channel, ...LAUNCH_OPTS });
  await acctContext.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const acctPage = await acctContext.newPage();
  await acctPage.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
  return { context: acctContext, page: acctPage };
}

export async function extractAccountInfoFromContext(page: Page): Promise<{ email: string | null, hasSession: boolean }> {
  const has = await hasSession(page);
  return { email: null, hasSession: has };
}

export async function closePlaywrightForAccount(accountId: string) {
  const acctContext = accountContexts.get(accountId);
  if (acctContext) {
    await acctContext.close().catch(() => {});
    accountContexts.delete(accountId);
    accountPages.delete(accountId);
  }
}

export async function closePlaywright() {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return;
  if (context) {
    await context.close().catch(() => {});
    context = null;
    activePage = null;
  }
  for (const acctId of [...accountContexts.keys()]) {
    await closePlaywrightForAccount(acctId);
  }
}

/** Compat: usado por api/models.ts. Retorna cookie/UA do perfil ativo. */
export async function getBasicHeaders(accountId?: string): Promise<{ cookie: string, userAgent: string }> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return { cookie: 'token=mock', userAgent: 'mock' };
  const page = (accountId && accountId !== 'global') ? accountPages.get(accountId) : activePage;
  if (!page) return { cookie: '', userAgent: LAUNCH_OPTS.userAgent };
  const cookies = await page.context().cookies().catch(() => []);
  return { cookie: cookies.map(c => `${c.name}=${c.value}`).join('; '), userAgent: LAUNCH_OPTS.userAgent };
}

/**
 * Probe READ-ONLY da saúde do bridge (não relança nada — o auto-heal acontece
 * no caminho do request, sob mutex, sem risco de corrida com streams ativos).
 * Usado pelo /health para observabilidade ("parou" deixa de ser silencioso).
 */
export async function getBridgeHealth(): Promise<{ browser: 'up' | 'down'; loggedIn: boolean | 'unknown' }> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) return { browser: 'up', loggedIn: true };
  // Considera a página global E as páginas por-conta (em modo multi-conta o
  // activePage global é null, mas os contextos de conta estão vivos).
  const pages = [activePage, ...accountPages.values()].filter(isPageUsable);
  if (pages.length === 0) return { browser: 'down', loggedIn: 'unknown' };
  try {
    const sessions = await Promise.all(pages.map(p => hasSession(p).catch(() => false)));
    return { browser: 'up', loggedIn: sessions.some(Boolean) };
  } catch {
    return { browser: 'down', loggedIn: 'unknown' };
  }
}

// ---------------------------------------------------------------------------
// Mutex (idêntico aos outros portes — serializa requests por conta no chat.ts)
// ---------------------------------------------------------------------------
export class Mutex {
  private queue: (() => void)[] = [];
  private locked = false;
  private currentToken: symbol | null = null;

  async acquire(timeoutMs = config.timeouts.mutexAcquire): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      const token = Symbol();
      this.currentToken = token;
      return () => this.release(token);
    }
    return new Promise<() => void>(resolve => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const grant = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const token = Symbol();
        this.currentToken = token;
        resolve(() => this.release(token));
      };
      this.queue.push(grant);
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          console.error(`[Mutex] acquire timed out after ${timeoutMs}ms; forcing lock takeover.`);
          const idx = this.queue.indexOf(grant);
          if (idx !== -1) this.queue.splice(idx, 1);
          const token = Symbol();
          this.currentToken = token;
          this.locked = true;
          resolve(() => this.release(token));
        }, timeoutMs);
      }
    });
  }

  private release(token: symbol): void {
    if (token !== this.currentToken) return;
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
      this.currentToken = null;
    }
  }
}
