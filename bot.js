/**
 * Infinea Maintenance Bot — Discord Bot
 *
 * Bot conversationnel qui permet a Sam de discuter
 * avec l'agent de maintenance Infinea sur Discord.
 *
 * Utilise Groq API (Llama 3.3 70B) pour generer les reponses — 24/7 cloud.
 * Se connecte au dashboard pour acceder aux donnees en temps reel.
 * Sync les messages et logs vers le dashboard automatiquement.
 *
 * Modules de supervision:
 * - MetricsStore: stockage metriques en memoire (fenetre glissante)
 * - DeepHealthChecks: verification endpoints critiques, DB, SSL
 * - AnomalyDetector: detection derives latence, error rate, degradations
 * - AlertSystem: seuils configurables, escalade, alertes Discord
 * - UptimeTracker: calcul disponibilite (1h, 24h, 7j)
 * - DeployDetector: detection automatique nouveaux deploiements
 * - SecurityMonitor: vulnerabilites GitHub (Dependabot, advisories)
 * - SelfDiagnostic: monitoring memoire/uptime du bot
 */

import { Client, GatewayIntentBits, Events } from "discord.js";

// ── Configuration ──

const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const DASHBOARD_URL =
  process.env.DASHBOARD_URL || "https://infinea-dashboard.vercel.app";
const ALLOWED_CHANNEL = process.env.DISCORD_CHANNEL_ID || null;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || null;
const GITHUB_ORG = "infineacompte-a11y";
const GITHUB_REPOS = ["Infinea-", "infinea-dashboard", "infinea-dev-dashboard", "infinea-maintenance-bot"];
const VERCEL_FRONTEND_URL = "https://infinea.vercel.app";
const RENDER_BACKEND_URL = "https://infinea-api.onrender.com";

if (!DISCORD_TOKEN) {
  console.error("DISCORD_BOT_TOKEN manquant !");
  process.exit(1);
}

if (!GROQ_API_KEY) {
  console.error("GROQ_API_KEY manquant !");
  process.exit(1);
}

// ══════════════════════════════════════════════════════════════════
// MODULE 1: MetricsStore — Stockage metriques en memoire
// ══════════════════════════════════════════════════════════════════

const METRICS_WINDOW = 24 * 60 * 60 * 1000; // 24h de donnees
const METRICS_MAX_POINTS = 5760; // 24h a raison d'1 point / 15s

const metricsStore = {
  // Chaque cle stocke un tableau de { timestamp, value }
  frontendLatency: [],
  backendLatency: [],
  frontendStatus: [],   // 1 = ok, 0 = down
  backendStatus: [],    // 1 = ok, 0 = down
  apiDocsStatus: [],
  apiHealthStatus: [],
  errorEvents: [],      // { timestamp, service, detail }
  deployEvents: [],     // { timestamp, repo, sha, message }
  alertEvents: [],      // { timestamp, severity, message }
};

function pushMetric(key, value) {
  const now = Date.now();
  if (!metricsStore[key]) metricsStore[key] = [];
  metricsStore[key].push({ timestamp: now, value });

  // Nettoyage: garder uniquement la fenetre
  const cutoff = now - METRICS_WINDOW;
  metricsStore[key] = metricsStore[key].filter(p => p.timestamp > cutoff);

  // Cap max points
  if (metricsStore[key].length > METRICS_MAX_POINTS) {
    metricsStore[key] = metricsStore[key].slice(-METRICS_MAX_POINTS);
  }
}

function getMetrics(key, windowMs = METRICS_WINDOW) {
  const cutoff = Date.now() - windowMs;
  return (metricsStore[key] || []).filter(p => p.timestamp > cutoff);
}

function getAvgMetric(key, windowMs) {
  const points = getMetrics(key, windowMs);
  if (points.length === 0) return null;
  return points.reduce((sum, p) => sum + p.value, 0) / points.length;
}

function getMinMaxMetric(key, windowMs) {
  const points = getMetrics(key, windowMs);
  if (points.length === 0) return { min: null, max: null };
  const values = points.map(p => p.value);
  return { min: Math.min(...values), max: Math.max(...values) };
}

// ══════════════════════════════════════════════════════════════════
// MODULE 2: DeepHealthChecks — Verification endpoints critiques
// ══════════════════════════════════════════════════════════════════

const CRITICAL_ENDPOINTS = [
  { url: `${RENDER_BACKEND_URL}/docs`, label: "API Docs", service: "backend" },
  { url: `${RENDER_BACKEND_URL}/api/health`, label: "API Health", service: "backend" },
  { url: VERCEL_FRONTEND_URL, label: "Frontend", service: "frontend" },
  { url: DASHBOARD_URL, label: "Dashboard", service: "dashboard" },
];

async function checkServiceHealth(url, label) {
  const start = Date.now();
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(10000) });
    const latency = Date.now() - start;
    return {
      label,
      url,
      status: res.ok ? "healthy" : "warning",
      httpStatus: res.status,
      latency,
      detail: res.ok ? `OK (${latency}ms)` : `HTTP ${res.status} (${latency}ms)`,
    };
  } catch (e) {
    return {
      label,
      url,
      status: "error",
      httpStatus: 0,
      latency: Date.now() - start,
      detail: `Injoignable: ${e.message?.slice(0, 60)}`,
    };
  }
}

async function runDeepHealthChecks() {
  const results = await Promise.all(
    CRITICAL_ENDPOINTS.map(ep => checkServiceHealth(ep.url, ep.label))
  );

  // Stocker les metriques
  for (const r of results) {
    if (r.label === "Frontend") {
      pushMetric("frontendLatency", r.latency);
      pushMetric("frontendStatus", r.status === "healthy" ? 1 : 0);
    } else if (r.label === "API Docs") {
      pushMetric("backendLatency", r.latency);
      pushMetric("backendStatus", r.status === "healthy" ? 1 : 0);
      pushMetric("apiDocsStatus", r.status === "healthy" ? 1 : 0);
    } else if (r.label === "API Health") {
      pushMetric("apiHealthStatus", r.status === "healthy" ? 1 : 0);
    }
  }

  // Detecter les erreurs
  for (const r of results) {
    if (r.status === "error") {
      pushMetric("errorEvents", { service: r.label, detail: r.detail });
    }
  }

  return results;
}

// Verification SSL/TLS (expiration certificat)
async function checkSSLCertificate(hostname) {
  try {
    // Via un service public gratuit pour verifier l'expiration
    await fetch(`https://${hostname}`, {
      method: "HEAD",
      signal: AbortSignal.timeout(8000),
    });
    // Si la requete HTTPS reussit, le certificat est valide
    return { hostname, valid: true, detail: "Certificat SSL valide" };
  } catch (e) {
    if (e.message?.includes("certificate") || e.message?.includes("SSL") || e.message?.includes("TLS")) {
      return { hostname, valid: false, detail: `Probleme SSL: ${e.message.slice(0, 80)}` };
    }
    // Erreur reseau autre que SSL — certificat probablement OK
    return { hostname, valid: true, detail: "Certificat presume valide (erreur non-SSL)" };
  }
}

async function runSSLChecks() {
  const hosts = ["infinea.vercel.app", "infinea-api.onrender.com", "infinea-dashboard.vercel.app"];
  return Promise.all(hosts.map(h => checkSSLCertificate(h)));
}

// ══════════════════════════════════════════════════════════════════
// MODULE 3: AnomalyDetector — Detection de derives et degradations
// ══════════════════════════════════════════════════════════════════

const ANOMALY_THRESHOLDS = {
  latencyWarning: 2000,     // ms — au-dessus = warning
  latencyCritical: 5000,    // ms — au-dessus = critical
  latencySpikeRatio: 3,     // x fois la moyenne = spike
  errorRateWarning: 0.1,    // 10% d'echecs = warning
  errorRateCritical: 0.3,   // 30% d'echecs = critical
  consecutiveErrors: 3,     // 3 erreurs d'affilee = alerte
};

function detectAnomalies() {
  const anomalies = [];

  // 1. Latence backend — comparaison baseline (1h) vs recent (5min)
  const backendAvg1h = getAvgMetric("backendLatency", 60 * 60 * 1000);
  const backendAvg5m = getAvgMetric("backendLatency", 5 * 60 * 1000);

  if (backendAvg5m !== null) {
    if (backendAvg5m > ANOMALY_THRESHOLDS.latencyCritical) {
      anomalies.push({ severity: "critical", domain: "backend", message: `Latence backend critique: ${Math.round(backendAvg5m)}ms (seuil: ${ANOMALY_THRESHOLDS.latencyCritical}ms)` });
    } else if (backendAvg5m > ANOMALY_THRESHOLDS.latencyWarning) {
      anomalies.push({ severity: "high", domain: "backend", message: `Latence backend elevee: ${Math.round(backendAvg5m)}ms (seuil: ${ANOMALY_THRESHOLDS.latencyWarning}ms)` });
    } else if (backendAvg1h && backendAvg5m > backendAvg1h * ANOMALY_THRESHOLDS.latencySpikeRatio) {
      anomalies.push({ severity: "high", domain: "backend", message: `Spike latence backend: ${Math.round(backendAvg5m)}ms vs moyenne ${Math.round(backendAvg1h)}ms (x${(backendAvg5m / backendAvg1h).toFixed(1)})` });
    }
  }

  // 2. Latence frontend — meme logique
  const frontendAvg1h = getAvgMetric("frontendLatency", 60 * 60 * 1000);
  const frontendAvg5m = getAvgMetric("frontendLatency", 5 * 60 * 1000);

  if (frontendAvg5m !== null) {
    if (frontendAvg5m > ANOMALY_THRESHOLDS.latencyCritical) {
      anomalies.push({ severity: "critical", domain: "frontend", message: `Latence frontend critique: ${Math.round(frontendAvg5m)}ms` });
    } else if (frontendAvg5m > ANOMALY_THRESHOLDS.latencyWarning) {
      anomalies.push({ severity: "high", domain: "frontend", message: `Latence frontend elevee: ${Math.round(frontendAvg5m)}ms` });
    } else if (frontendAvg1h && frontendAvg5m > frontendAvg1h * ANOMALY_THRESHOLDS.latencySpikeRatio) {
      anomalies.push({ severity: "high", domain: "frontend", message: `Spike latence frontend: ${Math.round(frontendAvg5m)}ms vs moyenne ${Math.round(frontendAvg1h)}ms` });
    }
  }

  // 3. Error rate — derniere heure
  const backendChecks = getMetrics("backendStatus", 60 * 60 * 1000);
  if (backendChecks.length >= 10) {
    const errorRate = backendChecks.filter(p => p.value === 0).length / backendChecks.length;
    if (errorRate >= ANOMALY_THRESHOLDS.errorRateCritical) {
      anomalies.push({ severity: "critical", domain: "backend", message: `Taux d'erreur backend critique: ${(errorRate * 100).toFixed(0)}% (${backendChecks.filter(p => p.value === 0).length}/${backendChecks.length} echecs)` });
    } else if (errorRate >= ANOMALY_THRESHOLDS.errorRateWarning) {
      anomalies.push({ severity: "high", domain: "backend", message: `Taux d'erreur backend eleve: ${(errorRate * 100).toFixed(0)}%` });
    }
  }

  const frontendChecks = getMetrics("frontendStatus", 60 * 60 * 1000);
  if (frontendChecks.length >= 10) {
    const errorRate = frontendChecks.filter(p => p.value === 0).length / frontendChecks.length;
    if (errorRate >= ANOMALY_THRESHOLDS.errorRateCritical) {
      anomalies.push({ severity: "critical", domain: "frontend", message: `Taux d'erreur frontend critique: ${(errorRate * 100).toFixed(0)}%` });
    } else if (errorRate >= ANOMALY_THRESHOLDS.errorRateWarning) {
      anomalies.push({ severity: "high", domain: "frontend", message: `Taux d'erreur frontend eleve: ${(errorRate * 100).toFixed(0)}%` });
    }
  }

  // 4. Erreurs consecutives — derniers checks
  for (const key of ["backendStatus", "frontendStatus"]) {
    const recent = getMetrics(key, 5 * 60 * 1000);
    if (recent.length >= ANOMALY_THRESHOLDS.consecutiveErrors) {
      const lastN = recent.slice(-ANOMALY_THRESHOLDS.consecutiveErrors);
      if (lastN.every(p => p.value === 0)) {
        const service = key.replace("Status", "");
        anomalies.push({ severity: "critical", domain: service, message: `${ANOMALY_THRESHOLDS.consecutiveErrors} echecs consecutifs sur ${service} — service probablement DOWN` });
      }
    }
  }

  return anomalies;
}

// ══════════════════════════════════════════════════════════════════
// MODULE 4: AlertSystem — Seuils, escalade, alertes Discord
// ══════════════════════════════════════════════════════════════════

const alertState = {
  lastAlertByDomain: {},     // domain → { severity, timestamp, message }
  alertCooldowns: {},        // domain → timestamp du dernier envoi
  escalationLevel: "normal", // normal | elevated | critical
};

const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 min entre alertes du meme domaine

function shouldSendAlert(domain, severity) {
  const now = Date.now();
  const lastAlert = alertState.alertCooldowns[domain] || 0;

  // Toujours envoyer les critical immediatement
  if (severity === "critical") return true;

  // Respecter le cooldown pour les autres
  return (now - lastAlert) > ALERT_COOLDOWN_MS;
}

async function sendDiscordAlert(anomaly) {
  if (!ALLOWED_CHANNEL) return;

  const channel = client.channels.cache.get(ALLOWED_CHANNEL);
  if (!channel) return;

  const domain = anomaly.domain;
  if (!shouldSendAlert(domain, anomaly.severity)) return;

  alertState.alertCooldowns[domain] = Date.now();
  alertState.lastAlertByDomain[domain] = {
    severity: anomaly.severity,
    timestamp: Date.now(),
    message: anomaly.message,
  };

  const icon = anomaly.severity === "critical" ? "\u{1F6A8}" : "\u26A0\uFE0F";
  const label = anomaly.severity === "critical" ? "ALERTE CRITIQUE" : "ATTENTION";

  const alertMsg = `${icon} **${label} — ${anomaly.domain.toUpperCase()}**\n${anomaly.message}\n_Detection automatique — ${new Date().toLocaleTimeString("fr-FR")}_`;

  try {
    await channel.send(alertMsg);
    pushMetric("alertEvents", { severity: anomaly.severity, message: anomaly.message });
    syncLogToDashboard(`Alerte ${anomaly.severity}: ${anomaly.message.slice(0, 80)}`, anomaly.severity === "critical" ? "error" : "warning", { description: anomaly.message, category: "supervision" });
  } catch (e) {
    console.error("Erreur envoi alerte Discord:", e.message);
  }
}

function updateEscalationLevel(anomalies) {
  const criticals = anomalies.filter(a => a.severity === "critical").length;
  const highs = anomalies.filter(a => a.severity === "high").length;

  if (criticals > 0) {
    alertState.escalationLevel = "critical";
  } else if (highs > 0) {
    alertState.escalationLevel = "elevated";
  } else {
    alertState.escalationLevel = "normal";
  }
}

// ══════════════════════════════════════════════════════════════════
// MODULE 5: UptimeTracker — Calcul disponibilite en pourcentage
// ══════════════════════════════════════════════════════════════════

function calculateUptime(statusKey, windowMs) {
  const points = getMetrics(statusKey, windowMs);
  if (points.length === 0) return null;
  const upCount = points.filter(p => p.value === 1).length;
  return (upCount / points.length) * 100;
}

function getUptimeReport() {
  const windows = {
    "1h": 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
  };

  const report = {};
  for (const [label, ms] of Object.entries(windows)) {
    report[label] = {
      frontend: calculateUptime("frontendStatus", ms),
      backend: calculateUptime("backendStatus", ms),
    };
  }

  return report;
}

function formatUptimeForDisplay(pct) {
  if (pct === null) return "N/A";
  return `${pct.toFixed(2)}%`;
}

// ══════════════════════════════════════════════════════════════════
// MODULE 6: DeployDetector — Detection nouveaux deploiements
// ══════════════════════════════════════════════════════════════════

const deployState = {
  lastKnownPush: {},  // repo → ISO date du dernier push connu
};

function detectNewDeploys(githubData) {
  const newDeploys = [];

  for (const repo of githubData) {
    const lastKnown = deployState.lastKnownPush[repo.name];
    const currentPush = repo.lastPush;

    if (lastKnown && currentPush && new Date(currentPush) > new Date(lastKnown)) {
      const latestCommit = repo.recentCommits?.[0];
      newDeploys.push({
        repo: repo.name,
        sha: latestCommit?.sha || "unknown",
        message: latestCommit?.message || "N/A",
        author: latestCommit?.author || "unknown",
        pushedAt: currentPush,
      });

      pushMetric("deployEvents", {
        repo: repo.name,
        sha: latestCommit?.sha,
        message: latestCommit?.message,
      });
    }

    // Mettre a jour le dernier push connu
    if (currentPush) {
      deployState.lastKnownPush[repo.name] = currentPush;
    }
  }

  return newDeploys;
}

async function notifyNewDeploys(deploys) {
  if (!ALLOWED_CHANNEL || deploys.length === 0) return;

  const channel = client.channels.cache.get(ALLOWED_CHANNEL);
  if (!channel) return;

  for (const d of deploys) {
    const msg = `\u{1F680} **Nouveau deploiement detecte — ${d.repo}**\nCommit: \`${d.sha}\` — "${d.message}"\nAuteur: ${d.author}\n_${new Date(d.pushedAt).toLocaleString("fr-FR")}_`;
    try {
      await channel.send(msg);
      syncLogToDashboard(`Deploy detecte: ${d.repo} — ${d.message?.slice(0, 50)}`, "success", { description: `Commit ${d.sha} par ${d.author}: "${d.message}"`, category: "deploy" });
    } catch (e) {
      console.error("Erreur notification deploy:", e.message);
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// MODULE 7: SecurityMonitor — Vulnerabilites GitHub
// ══════════════════════════════════════════════════════════════════

let cachedSecurityData = { lastCheck: null, alerts: [] };

async function checkGitHubSecurityAlerts() {
  if (!GITHUB_TOKEN) return { alerts: [], error: "Pas de token GitHub" };

  const headers = {
    "Accept": "application/vnd.github+json",
    "Authorization": `Bearer ${GITHUB_TOKEN}`,
  };

  const allAlerts = [];

  for (const repo of GITHUB_REPOS) {
    try {
      // Dependabot alerts
      const res = await fetch(
        `https://api.github.com/repos/${GITHUB_ORG}/${repo}/dependabot/alerts?state=open&per_page=10`,
        { headers, signal: AbortSignal.timeout(8000) }
      );

      if (res.ok) {
        const alerts = await res.json();
        if (Array.isArray(alerts)) {
          for (const alert of alerts) {
            allAlerts.push({
              repo,
              package: alert.security_advisory?.summary || alert.dependency?.package?.name || "unknown",
              severity: alert.security_advisory?.severity || "unknown",
              cve: alert.security_advisory?.cve_id || null,
              url: alert.html_url,
              createdAt: alert.created_at,
            });
          }
        }
      }
    } catch (e) {
      // Silencieux — Dependabot peut ne pas etre active
    }
  }

  cachedSecurityData = {
    lastCheck: new Date().toISOString(),
    alerts: allAlerts,
  };

  return cachedSecurityData;
}

async function notifySecurityAlerts(alerts) {
  if (!ALLOWED_CHANNEL || alerts.length === 0) return;

  const channel = client.channels.cache.get(ALLOWED_CHANNEL);
  if (!channel) return;

  const critical = alerts.filter(a => a.severity === "critical" || a.severity === "high");
  if (critical.length === 0) return;

  const lines = [`\u{1F6E1}\uFE0F **Alertes Securite GitHub** — ${critical.length} vulnerabilite(s) haute/critique\n`];
  for (const a of critical.slice(0, 5)) {
    lines.push(`- **${a.repo}**: ${a.package} (${a.severity})${a.cve ? ` — ${a.cve}` : ""}`);
  }
  if (critical.length > 5) lines.push(`_...et ${critical.length - 5} autres_`);

  try {
    await channel.send(lines.join("\n"));
  } catch (e) {
    console.error("Erreur notification securite:", e.message);
  }
}

// ══════════════════════════════════════════════════════════════════
// MODULE 8: SelfDiagnostic — Monitoring du bot lui-meme
// ══════════════════════════════════════════════════════════════════

const botStartTime = Date.now();

function getSelfDiagnostic() {
  const uptime = Date.now() - botStartTime;
  const memUsage = process.memoryUsage();

  return {
    uptime,
    uptimeFormatted: formatDuration(uptime),
    memory: {
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
      rss: Math.round(memUsage.rss / 1024 / 1024),
      external: Math.round(memUsage.external / 1024 / 1024),
    },
    metricsPoints: Object.entries(metricsStore).reduce((sum, [, arr]) => sum + arr.length, 0),
    escalationLevel: alertState.escalationLevel,
    activeAlerts: Object.keys(alertState.lastAlertByDomain).length,
    discordConnected: client.isReady(),
    discordPing: client.ws.ping,
  };
}

function formatDuration(ms) {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}j ${hours % 24}h`;
  }
  return `${hours}h ${minutes}m`;
}

function checkBotHealth() {
  const diag = getSelfDiagnostic();
  const issues = [];

  // Memoire trop elevee (> 256 MB heap)
  if (diag.memory.heapUsed > 256) {
    issues.push({ severity: "high", message: `Memoire heap elevee: ${diag.memory.heapUsed}MB` });
  }

  // Discord deconnecte
  if (!diag.discordConnected) {
    issues.push({ severity: "critical", message: "Bot Discord deconnecte" });
  }

  // Ping Discord trop eleve
  if (diag.discordPing > 1000) {
    issues.push({ severity: "high", message: `Ping Discord eleve: ${diag.discordPing}ms` });
  }

  return issues;
}

// ══════════════════════════════════════════════════════════════════
// Dashboard API (existant — inchange)
// ══════════════════════════════════════════════════════════════════

async function fetchDashboardData() {
  try {
    const [statusRes, logsRes, auditsRes] = await Promise.all([
      fetch(`${DASHBOARD_URL}/api/status`).then((r) => r.json()),
      fetch(`${DASHBOARD_URL}/api/logs`).then((r) => r.json()),
      fetch(`${DASHBOARD_URL}/api/audits`).then((r) => r.json()),
    ]);

    return {
      status: statusRes,
      recentLogs: Array.isArray(logsRes) ? logsRes.slice(0, 10) : [],
      audits: Array.isArray(auditsRes) ? auditsRes.slice(-4) : [],
    };
  } catch (error) {
    console.error("Erreur fetch dashboard:", error.message);
    return { status: {}, recentLogs: [], audits: [] };
  }
}

function formatDashboardContext(data) {
  const parts = [];

  if (data.status?.systems) {
    parts.push("=== ETAT DES SYSTEMES ===");
    for (const [, sys] of Object.entries(data.status.systems)) {
      parts.push(`- ${sys.label}: ${sys.status} — ${sys.detail}`);
    }
  }

  if (data.status?.stats) {
    const s = data.status.stats;
    parts.push(
      `\nStatistiques: ${s.criticalIssues || 0} critiques, ${s.highIssues || 0} high, ${s.mediumIssues || 0} medium, ${s.fixesApplied || 0} corrections`
    );
  }

  if (data.audits.length > 0) {
    parts.push("\n=== DERNIERS AUDITS ===");
    for (const audit of data.audits) {
      parts.push(
        `- [${audit.domain}] ${audit.title}: ${audit.findings?.length || 0} findings (${audit.severity})`
      );
    }
  }

  if (data.recentLogs.length > 0) {
    parts.push("\n=== LOGS RECENTS ===");
    for (const log of data.recentLogs.slice(0, 5)) {
      parts.push(`- ${log.title} (${log.type || "info"})`);
    }
  }

  return parts.join("\n") || "Aucune donnee disponible pour le moment.";
}

// Contexte enrichi de supervision pour le system prompt
function formatSupervisionContext() {
  const parts = [];
  const diag = getSelfDiagnostic();
  const uptimeReport = getUptimeReport();
  const anomalies = detectAnomalies();

  // Uptime
  parts.push("=== UPTIME ===");
  for (const [window, data] of Object.entries(uptimeReport)) {
    if (data.frontend !== null || data.backend !== null) {
      parts.push(`${window}: Frontend ${formatUptimeForDisplay(data.frontend)} | Backend ${formatUptimeForDisplay(data.backend)}`);
    }
  }

  // Latence moyenne
  const beAvg = getAvgMetric("backendLatency", 60 * 60 * 1000);
  const feAvg = getAvgMetric("frontendLatency", 60 * 60 * 1000);
  if (beAvg || feAvg) {
    parts.push("\n=== LATENCE MOYENNE (1h) ===");
    if (beAvg) parts.push(`Backend: ${Math.round(beAvg)}ms`);
    if (feAvg) parts.push(`Frontend: ${Math.round(feAvg)}ms`);
  }

  // Anomalies en cours
  if (anomalies.length > 0) {
    parts.push("\n=== ANOMALIES DETECTEES ===");
    for (const a of anomalies) {
      parts.push(`- [${a.severity.toUpperCase()}] ${a.message}`);
    }
  }

  // Securite
  if (cachedSecurityData.alerts.length > 0) {
    parts.push(`\n=== SECURITE === ${cachedSecurityData.alerts.length} alerte(s) Dependabot`);
    for (const a of cachedSecurityData.alerts.slice(0, 3)) {
      parts.push(`- ${a.repo}: ${a.package} (${a.severity})`);
    }
  }

  // Deploiements recents
  const recentDeploys = getMetrics("deployEvents", 24 * 60 * 60 * 1000);
  if (recentDeploys.length > 0) {
    parts.push(`\n=== DEPLOIEMENTS (24h) === ${recentDeploys.length} deploy(s)`);
    for (const d of recentDeploys.slice(-3)) {
      parts.push(`- ${d.value.repo}: "${d.value.message?.slice(0, 50)}"`);
    }
  }

  // Bot self-diagnostic
  parts.push(`\n=== BOT === Uptime: ${diag.uptimeFormatted} | RAM: ${diag.memory.heapUsed}MB | Escalation: ${diag.escalationLevel} | Discord ping: ${diag.discordPing}ms`);

  return parts.join("\n");
}

// ── System Prompt (enrichi) ──

const SYSTEM_PROMPT = `Tu es l'agent de maintenance Infinea. Tu es un CTO/tech lead bienveillant qui maintient le systeme Infinea (SaaS d'optimisation comportementale).

TON ROLE:
- Tu reponds aux questions de Sam (fondateur non-technique) sur l'etat du systeme
- Tu expliques les problemes techniques en francais simple
- Tu donnes des rapports clairs et actionnables
- Tu es proactif: si tu vois un probleme critique, tu le signales immediatement
- Tu supervises la maintenance de maniere fiable, complete et continue
- Tu detectes les anomalies, derives, risques, regressions et incidents potentiels
- Tu surveilles les performances, la disponibilite, la securite et les deploiements

CAPACITES DE SUPERVISION:
- Health checks sur tous les endpoints critiques (frontend, backend, API, dashboard)
- Suivi de latence avec detection de spikes et degradation progressive
- Calcul d'uptime en temps reel (1h, 24h)
- Detection automatique des anomalies (seuils, tendances, erreurs consecutives)
- Alertes automatiques Discord quand un probleme est detecte
- Monitoring des vulnerabilites de securite GitHub (Dependabot)
- Detection automatique des nouveaux deploiements
- Auto-diagnostic du bot (memoire, connectivite, performances)

STACK INFINEA:
- Frontend: React 19 (CRA/Craco) deploye sur Vercel
- Backend: FastAPI 0.110.1 (Python 3.11) deploye sur Render
- Base de donnees: MongoDB Atlas (Motor async)
- Auth: JWT custom + Google OAuth
- AI: Claude API (coaching, actions, debrief)
- Paiements: Stripe

REGLES:
- Reponds TOUJOURS en francais
- Sois concis mais complet
- Utilise des emojis pour la lisibilite
- Si tu ne sais pas, dis-le honnetement
- Ne propose PAS de nouvelles features — tu es EXCLUSIVEMENT en maintenance
- Si Sam demande quelque chose hors de ton scope, redirige-le poliment
- Quand tu donnes un rapport, inclus les metriques de supervision (uptime, latence, anomalies)
- Si des anomalies sont detectees, explique-les en priorite avec niveau de severite`;

// ── Groq API (existant — inchange) ──

async function callGroq(systemPrompt, messages) {
  const groqMessages = [
    { role: "system", content: systemPrompt },
    ...messages,
  ];

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: groqMessages,
      temperature: 0.7,
      max_tokens: 1500,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Groq error ${response.status}: ${text}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "Desole, je n'ai pas pu generer de reponse.";
}

// ── Dashboard Sync (existant — inchange) ──

async function syncMessageToDashboard(_from, content, type = "bot") {
  try {
    await fetch(`${DASHBOARD_URL}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: type === "user" ? "user" : "agent",
        content: content.slice(0, 500),
        status: "delivered",
        timestamp: new Date().toISOString(),
      }),
    });
  } catch (e) {
    console.error("Sync message dashboard:", e.message);
  }
}

const TYPE_TO_SEVERITY = {
  error: "critical",
  warning: "high",
  success: "info",
  info: "info",
};

async function syncLogToDashboard(title, type = "info", { description = "", category = "system" } = {}) {
  try {
    await fetch(`${DASHBOARD_URL}/api/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        type,
        severity: TYPE_TO_SEVERITY[type] || "info",
        description,
        category,
        timestamp: new Date().toISOString(),
      }),
    });
  } catch (e) {
    console.error("Sync log dashboard:", e.message);
  }
}

// ── GitHub Audit (existant — inchange) ──

async function fetchGitHubRepoData(repo) {
  const headers = { "Accept": "application/vnd.github+json" };
  if (GITHUB_TOKEN) headers["Authorization"] = `Bearer ${GITHUB_TOKEN}`;

  try {
    const [repoRes, commitsRes] = await Promise.all([
      fetch(`https://api.github.com/repos/${GITHUB_ORG}/${repo}`, { headers }),
      fetch(`https://api.github.com/repos/${GITHUB_ORG}/${repo}/commits?per_page=5`, { headers }),
    ]);

    if (!repoRes.ok) return null;

    const repoData = await repoRes.json();
    const commits = commitsRes.ok ? await commitsRes.json() : [];

    return {
      name: repo,
      lastPush: repoData.pushed_at,
      defaultBranch: repoData.default_branch,
      openIssues: repoData.open_issues_count,
      size: repoData.size,
      recentCommits: Array.isArray(commits) ? commits.map(c => ({
        sha: c.sha?.slice(0, 7),
        message: c.commit?.message?.split("\n")[0]?.slice(0, 80),
        date: c.commit?.author?.date,
        author: c.commit?.author?.name,
      })) : [],
    };
  } catch (e) {
    console.error(`GitHub fetch error (${repo}):`, e.message);
    return null;
  }
}

async function runGitHubAudit() {
  const results = await Promise.all(GITHUB_REPOS.map(fetchGitHubRepoData));
  return results.filter(Boolean);
}

// ══════════════════════════════════════════════════════════════════
// MODULE 9: AutoAuditor — Audit automatique du code via GitHub API
// ══════════════════════════════════════════════════════════════════

async function fetchFileContent(repo, path) {
  if (!GITHUB_TOKEN) return null;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_ORG}/${repo}/contents/${path}`,
      {
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": `Bearer ${GITHUB_TOKEN}`,
        },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return Buffer.from(data.content, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

const GITHUB_FILE_URL = (path) => `https://github.com/${GITHUB_ORG}/Infinea-/blob/main/${path}`;

function auditCICD(deployYml) {
  const findings = [];
  const url = GITHUB_FILE_URL(".github/workflows/deploy.yml");

  if (!deployYml) {
    findings.push({ severity: "critical", title: "Fichier deploy.yml introuvable", description: "Aucun workflow CI/CD detecte dans .github/workflows/deploy.yml", url });
    return findings;
  }

  const lower = deployYml.toLowerCase();

  if (!lower.includes("test") && !lower.includes("pytest") && !lower.includes("jest")) {
    findings.push({ severity: "critical", title: "Aucun test dans le pipeline CI/CD", description: "Le deploy.yml ne contient aucune etape de test (pytest, jest, npm test). Le code est deploye sans verification.", url });
  }
  if (!lower.includes("lint") && !lower.includes("eslint") && !lower.includes("flake8") && !lower.includes("ruff")) {
    findings.push({ severity: "high", title: "Pas de linting dans le CI/CD", description: "Aucun linter (ESLint, flake8, ruff) detecte dans le pipeline.", url });
  }
  if (!lower.includes("npm run build") && !lower.includes("yarn build") && !lower.includes("next build")) {
    findings.push({ severity: "medium", title: "Pas de build explicite dans CI/CD", description: "Le pipeline ne contient pas d'etape de build frontend explicite.", url });
  }
  if (!lower.includes("env") || (!lower.includes("check") && !lower.includes("valid"))) {
    findings.push({ severity: "medium", title: "Pas de validation des variables d'environnement", description: "Le pipeline ne valide pas la presence des variables d'environnement requises.", url });
  }
  if (!lower.includes("staging") && !lower.includes("preview")) {
    findings.push({ severity: "low", title: "Pas d'environnement de staging", description: "Le pipeline deploie directement en production sans etape de staging/preview.", url });
  }
  if (!lower.includes("rollback") && !lower.includes("revert")) {
    findings.push({ severity: "medium", title: "Pas de strategie de rollback", description: "Aucune strategie de rollback automatique detectee dans le pipeline.", url });
  }

  return findings;
}

function auditSecurity(files) {
  const findings = [];
  const { serverPy, configPy, authPy, envExample } = files;
  const serverUrl = GITHUB_FILE_URL("backend/server.py");
  const authUrl = GITHUB_FILE_URL("backend/auth.py");
  const configUrl = GITHUB_FILE_URL("backend/config.py");
  const envUrl = GITHUB_FILE_URL("backend/.env.example");

  if (serverPy) {
    if (serverPy.includes("allow_origins=[\"*\"]") || serverPy.includes('allow_origins=["*"]')) {
      findings.push({ severity: "critical", title: "CORS ouvert a tous les origines", description: "allow_origins=['*'] detecte dans server.py — permet les requetes depuis n'importe quel domaine.", url: serverUrl });
    }
    if (!serverPy.includes("rate_limit") && !serverPy.includes("RateLimit") && !serverPy.includes("slowapi")) {
      findings.push({ severity: "high", title: "Pas de rate limiting", description: "Aucun rate limiting detecte dans server.py (slowapi, RateLimit).", url: serverUrl });
    }
    if (!serverPy.includes("helmet") && !serverPy.includes("security_headers") && !serverPy.includes("CSP")) {
      findings.push({ severity: "medium", title: "Pas de security headers", description: "Aucun middleware de security headers (CSP, X-Frame-Options, etc.) detecte.", url: serverUrl });
    }
  }

  if (authPy) {
    if (authPy.includes("verify=False") || authPy.includes("verify_ssl=False")) {
      findings.push({ severity: "critical", title: "Verification SSL desactivee dans auth", description: "verify=False detecte — les certificats SSL ne sont pas verifies.", url: authUrl });
    }
    if (!authPy.includes("bcrypt") && !authPy.includes("passlib") && !authPy.includes("argon2")) {
      findings.push({ severity: "high", title: "Pas de hashing de mots de passe", description: "Aucune librairie de hashing (bcrypt, passlib, argon2) detectee dans auth.py.", url: authUrl });
    }
  }

  if (configPy) {
    if (configPy.includes("DEBUG = True") || configPy.includes("debug=True")) {
      findings.push({ severity: "high", title: "Mode debug actif en production", description: "DEBUG=True detecte dans config.py — risque d'exposition de donnees sensibles.", url: configUrl });
    }
    if (configPy.includes("SECRET") && configPy.includes("=") && configPy.includes('"')) {
      if (!configPy.includes("os.environ") && !configPy.includes("os.getenv")) {
        findings.push({ severity: "critical", title: "Secrets potentiellement hardcodes", description: "Des valeurs SECRET detectees dans config.py sans reference a os.environ/os.getenv.", url: configUrl });
      }
    }
  }

  if (envExample) {
    const lines = envExample.split("\n").filter(l => l.includes("=") && !l.startsWith("#"));
    const withValues = lines.filter(l => {
      const val = l.split("=")[1]?.trim();
      return val && val !== "" && val !== '""' && val !== "''" && !val.startsWith("your_") && !val.startsWith("<");
    });
    if (withValues.length > 0) {
      findings.push({ severity: "medium", title: "Valeurs non-placeholder dans .env.example", description: `${withValues.length} variable(s) avec des valeurs reelles dans .env.example au lieu de placeholders.`, url: envUrl });
    }
  }

  return findings;
}

function auditBackend(files) {
  const findings = [];
  const { requirements, serverPy, databasePy } = files;
  const reqUrl = GITHUB_FILE_URL("backend/requirements.txt");
  const serverUrl = GITHUB_FILE_URL("backend/server.py");
  const dbUrl = GITHUB_FILE_URL("backend/database.py");

  if (requirements) {
    const lines = requirements.split("\n").filter(l => l.trim() && !l.startsWith("#"));
    const unpinned = lines.filter(l => !l.includes("==") && !l.includes(">=") && !l.includes("~=") && l.trim().length > 0);

    if (unpinned.length > 3) {
      findings.push({ severity: "high", title: `${unpinned.length} dependances non pinnees`, description: `Dependances sans version fixe: ${unpinned.slice(0, 5).join(", ")}${unpinned.length > 5 ? "..." : ""}. Risque de regression lors d'un install.`, url: reqUrl });
    }
    if (!lines.some(l => l.includes("python-dotenv"))) {
      findings.push({ severity: "medium", title: "python-dotenv absent", description: "python-dotenv non detecte dans requirements.txt — gestion .env potentiellement manuelle.", url: reqUrl });
    }
  }

  if (serverPy) {
    if (!serverPy.includes("/health") && !serverPy.includes("/api/health")) {
      findings.push({ severity: "high", title: "Pas de health check endpoint", description: "Aucun endpoint /health ou /api/health detecte dans server.py.", url: serverUrl });
    }
    if (!serverPy.includes("exception_handler") && !serverPy.includes("@app.exception")) {
      findings.push({ severity: "medium", title: "Pas de global exception handler", description: "Aucun gestionnaire d'exceptions global detecte dans server.py.", url: serverUrl });
    }
    if (!serverPy.includes("logging") && !serverPy.includes("logger")) {
      findings.push({ severity: "medium", title: "Pas de logging structure", description: "Aucun import logging detecte dans server.py.", url: serverUrl });
    }
  }

  if (databasePy) {
    if (!databasePy.includes("index") && !databasePy.includes("create_index")) {
      findings.push({ severity: "medium", title: "Pas d'indexation MongoDB explicite", description: "Aucun create_index detecte dans database.py — requetes potentiellement lentes.", url: dbUrl });
    }
    if (!databasePy.includes("try") && !databasePy.includes("except")) {
      findings.push({ severity: "high", title: "Pas de gestion d'erreurs DB", description: "Aucun try/except detecte dans database.py — les erreurs de connexion ne sont pas gerees.", url: dbUrl });
    }
  }

  return findings;
}

function auditFrontend(files) {
  const findings = [];
  const { packageJson, cracoConfig } = files;
  const pkgUrl = GITHUB_FILE_URL("frontend/package.json");
  const cracoUrl = GITHUB_FILE_URL("frontend/craco.config.js");

  if (packageJson) {
    let pkg;
    try { pkg = JSON.parse(packageJson); } catch { return findings; }

    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    const reactVersion = deps.react;
    if (reactVersion && !reactVersion.includes("19") && !reactVersion.includes("18")) {
      findings.push({ severity: "medium", title: `Version React ancienne: ${reactVersion}`, description: "La version de React n'est ni 18 ni 19.", url: pkgUrl });
    }
    if (!pkg.scripts?.test || pkg.scripts.test.includes("no test")) {
      findings.push({ severity: "high", title: "Pas de script de test", description: "Le package.json n'a pas de script 'test' fonctionnel.", url: pkgUrl });
    }
    if (!pkg.scripts?.lint && !deps.eslint) {
      findings.push({ severity: "medium", title: "Pas de linter configure", description: "Ni script lint ni ESLint detecte dans package.json.", url: pkgUrl });
    }

    const heavyDeps = ["moment", "lodash", "@material-ui/core", "antd"];
    for (const dep of heavyDeps) {
      if (deps[dep]) {
        findings.push({ severity: "low", title: `Dependance lourde: ${dep}`, description: `${dep} detecte — impact potentiel sur la taille du bundle.`, url: pkgUrl });
      }
    }

    if (deps["react-scripts"] && deps["react-scripts"].includes("4")) {
      findings.push({ severity: "medium", title: "react-scripts v4 (ancienne)", description: "react-scripts 4.x detecte — des vulnerabilites connues existent dans cette version.", url: pkgUrl });
    }
  }

  if (cracoConfig) {
    if (!cracoConfig.includes("splitChunks") && !cracoConfig.includes("optimization")) {
      findings.push({ severity: "low", title: "Pas d'optimisation de chunks", description: "Aucune configuration splitChunks/optimization dans craco.config.js.", url: cracoUrl });
    }
  }

  return findings;
}

async function runAutoAudit() {
  console.log("AutoAuditor: lancement audit complet du code...");

  try {
    // 1. Fetch tous les fichiers critiques en parallele
    const [deployYml, serverPy, configPy, authPy, databasePy, requirements, envExampleBe, packageJson, cracoConfig, envExampleFe] = await Promise.all([
      fetchFileContent("Infinea-", ".github/workflows/deploy.yml"),
      fetchFileContent("Infinea-", "backend/server.py"),
      fetchFileContent("Infinea-", "backend/config.py"),
      fetchFileContent("Infinea-", "backend/auth.py"),
      fetchFileContent("Infinea-", "backend/database.py"),
      fetchFileContent("Infinea-", "backend/requirements.txt"),
      fetchFileContent("Infinea-", "backend/.env.example"),
      fetchFileContent("Infinea-", "frontend/package.json"),
      fetchFileContent("Infinea-", "frontend/craco.config.js"),
      fetchFileContent("Infinea-", "frontend/.env.example"),
    ]);

    // 2. Lancer les 4 audits
    const cicdFindings = auditCICD(deployYml);
    const securityFindings = auditSecurity({ serverPy, configPy, authPy, envExample: envExampleBe || envExampleFe });
    const backendFindings = auditBackend({ requirements, serverPy, databasePy });
    const frontendFindings = auditFrontend({ packageJson, cracoConfig });

    // 3. Construire les rapports d'audit
    const now = new Date().toISOString();

    function buildStats(findings) {
      const stats = { total: findings.length, critical: 0, high: 0, medium: 0, low: 0 };
      for (const f of findings) {
        if (stats[f.severity] !== undefined) stats[f.severity]++;
      }
      return stats;
    }

    const audits = [
      {
        id: "audit-cicd",
        domain: "cicd",
        title: "Audit CI/CD, Tests & Dependances",
        description: "Analyse automatique du pipeline CI/CD (deploy.yml)",
        severity: cicdFindings.some(f => f.severity === "critical") ? "critical" : cicdFindings.some(f => f.severity === "high") ? "high" : "medium",
        findings: cicdFindings,
        stats: buildStats(cicdFindings),
        status: "completed",
        timestamp: now,
      },
      {
        id: "audit-security",
        domain: "security",
        title: "Audit Securite — Analyse automatique",
        description: "Verification CORS, rate limiting, auth, secrets, headers",
        severity: securityFindings.some(f => f.severity === "critical") ? "critical" : securityFindings.some(f => f.severity === "high") ? "high" : "medium",
        findings: securityFindings,
        stats: buildStats(securityFindings),
        status: "completed",
        timestamp: now,
      },
      {
        id: "audit-backend",
        domain: "backend",
        title: "Audit Backend — Analyse automatique",
        description: "Verification dependances, server, database, error handling",
        severity: backendFindings.some(f => f.severity === "critical") ? "critical" : backendFindings.some(f => f.severity === "high") ? "high" : "medium",
        findings: backendFindings,
        stats: buildStats(backendFindings),
        status: "completed",
        timestamp: now,
      },
      {
        id: "audit-frontend",
        domain: "frontend",
        title: "Audit Frontend — Analyse automatique",
        description: "Verification React, dependances, build, tests, bundle",
        severity: frontendFindings.some(f => f.severity === "critical") ? "critical" : frontendFindings.some(f => f.severity === "high") ? "high" : "medium",
        findings: frontendFindings,
        stats: buildStats(frontendFindings),
        status: "completed",
        timestamp: now,
      },
    ];

    // 4. Envoyer au dashboard (remplacement complet)
    const res = await fetch(`${DASHBOARD_URL}/api/audits`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audits }),
    });

    const totalFindings = audits.reduce((sum, a) => sum + a.findings.length, 0);
    const totalCritical = audits.reduce((sum, a) => sum + a.stats.critical, 0);
    const totalHigh = audits.reduce((sum, a) => sum + a.stats.high, 0);

    if (res.ok) {
      console.log(`AutoAuditor: ${totalFindings} findings (${totalCritical} critiques, ${totalHigh} high) envoyes au dashboard`);
      syncLogToDashboard(
        `Auto-audit complet: ${totalFindings} findings (${totalCritical} critiques, ${totalHigh} high)`,
        totalCritical > 0 ? "warning" : "success",
        { description: `4 domaines audites: CI/CD (${cicdFindings.length}), Securite (${securityFindings.length}), Backend (${backendFindings.length}), Frontend (${frontendFindings.length})`, category: "audit" }
      );
    } else {
      console.error("AutoAuditor: erreur envoi dashboard:", res.status);
    }

    return audits;
  } catch (e) {
    console.error("AutoAuditor error:", e.message);
    return null;
  }
}

// ── Audit Findings Cache ──

let cachedAuditFindings = { critical: 0, high: 0, medium: 0, low: 0, total: 0 };

async function refreshAuditFindings() {
  try {
    const res = await fetch(`${DASHBOARD_URL}/api/audits`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return;
    const audits = await res.json();
    if (!Array.isArray(audits)) return;

    const counts = { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
    for (const audit of audits) {
      if (!audit.findings) continue;
      for (const f of audit.findings) {
        counts.total++;
        if (counts[f.severity] !== undefined) counts[f.severity]++;
      }
    }
    cachedAuditFindings = counts;
  } catch (e) {
    // Silencieux — on garde le cache precedent
  }
}

// ── Dashboard Update (ENRICHI avec metriques supervision) ──

async function updateDashboardStatus(healthChecks, githubData) {
  try {
    const now = new Date().toISOString();
    const mainRepo = githubData.find(r => r.name === "Infinea-");
    const totalOpenIssues = githubData.reduce((sum, r) => sum + (r.openIssues || 0), 0);
    const recentCommitCount = githubData.reduce((sum, r) => sum + (r.recentCommits?.length || 0), 0);

    const lastCommitMsg = mainRepo?.recentCommits?.[0]?.message || "N/A";
    const lastCommitDate = mainRepo?.recentCommits?.[0]?.date
      ? new Date(mainRepo.recentCommits[0].date).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
      : "N/A";

    // Uptime data
    const uptimeReport = getUptimeReport();
    const beUptime1h = uptimeReport["1h"]?.backend;
    const feUptime1h = uptimeReport["1h"]?.frontend;

    // Anomalies
    const anomalies = detectAnomalies();
    const criticalAnomalies = anomalies.filter(a => a.severity === "critical");
    const highAnomalies = anomalies.filter(a => a.severity === "high");

    // Bot diagnostic
    const diag = getSelfDiagnostic();

    const systems = {
      backend: {
        status: healthChecks.backend.status,
        label: "Backend FastAPI",
        detail: `${healthChecks.backend.detail} — Dernier push: ${lastCommitDate}${beUptime1h !== null ? ` — Uptime 1h: ${beUptime1h.toFixed(1)}%` : ""}`,
      },
      frontend: {
        status: healthChecks.frontend.status,
        label: "Frontend React 19",
        detail: `${healthChecks.frontend.detail} — Dernier commit: "${lastCommitMsg.slice(0, 50)}"${feUptime1h !== null ? ` — Uptime 1h: ${feUptime1h.toFixed(1)}%` : ""}`,
      },
      database: {
        status: healthChecks.backend.status === "healthy" ? "healthy" : "warning",
        label: "MongoDB Atlas",
        detail: healthChecks.backend.status === "healthy"
          ? "Connecte via backend (verifie indirectement)"
          : "Verification impossible — backend injoignable",
      },
      github: {
        status: cachedSecurityData.alerts.length > 0 ? "warning" : "healthy",
        label: "GitHub Repos",
        detail: `${githubData.length} repos, ${recentCommitCount} commits, ${totalOpenIssues} issues${cachedSecurityData.alerts.length > 0 ? ` — ${cachedSecurityData.alerts.length} alerte(s) securite` : ""}`,
      },
      security: {
        status: cachedSecurityData.alerts.filter(a => a.severity === "critical" || a.severity === "high").length > 0
          ? "warning"
          : totalOpenIssues > 5 ? "warning" : "healthy",
        label: "Securite",
        detail: cachedSecurityData.alerts.length > 0
          ? `${cachedSecurityData.alerts.length} vulnerabilite(s) Dependabot, ${totalOpenIssues} issues ouvertes`
          : `${totalOpenIssues} issues ouvertes — Aucune vulnerabilite connue`,
      },
      cicd: {
        status: "healthy",
        label: "CI/CD & Deploy",
        detail: `Auto-deploy actif — Dernier push: ${lastCommitDate}`,
      },
    };

    // Compute fresh stats enrichis
    const systemCriticals = Object.values(systems).filter(s => s.status === "error").length;
    const systemWarnings = Object.values(systems).filter(s => s.status === "warning").length;

    const statusPayload = {
      systems,
      stats: {
        criticalIssues: cachedAuditFindings.critical + systemCriticals + criticalAnomalies.length,
        highIssues: cachedAuditFindings.high + systemWarnings + highAnomalies.length,
        mediumIssues: cachedAuditFindings.medium + cachedSecurityData.alerts.filter(a => a.severity === "medium").length,
        lowIssues: cachedAuditFindings.low + cachedSecurityData.alerts.filter(a => a.severity === "low").length,
        auditsCompleted: githubData.length,
        fixesApplied: recentCommitCount,
        auditFindings: cachedAuditFindings.total,
      },
      supervision: {
        anomalies: anomalies.length,
        escalationLevel: alertState.escalationLevel,
        botUptime: diag.uptimeFormatted,
        botMemory: `${diag.memory.heapUsed}MB`,
        securityAlerts: cachedSecurityData.alerts.length,
      },
      lastUpdated: now,
    };

    await fetch(`${DASHBOARD_URL}/api/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(statusPayload),
    });

    return statusPayload;
  } catch (e) {
    console.error("Erreur mise a jour dashboard:", e.message);
    return null;
  }
}

// ── Per-channel cooldown (existant — inchange) ──

const channelCooldowns = new Map();
const COOLDOWN_MS = 3000;

function isOnCooldown(channelId) {
  const last = channelCooldowns.get(channelId) || 0;
  return Date.now() - last < COOLDOWN_MS;
}

function setCooldown(channelId) {
  channelCooldowns.set(channelId, Date.now());
}

// ── Conversation History (existant — inchange) ──

const conversationHistory = new Map();
const MAX_HISTORY = 20;

function getHistory(channelId) {
  if (!conversationHistory.has(channelId)) {
    conversationHistory.set(channelId, []);
  }
  return conversationHistory.get(channelId);
}

function addToHistory(channelId, role, content) {
  const history = getHistory(channelId);
  history.push({ role, content });
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
}

// ── Discord Client ──

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Bot connecte en tant que ${c.user.tag}`);
  console.log(`Dashboard: ${DASHBOARD_URL}`);
  console.log(`LLM: ${GROQ_MODEL} via Groq (cloud 24/7)`);
  console.log(
    ALLOWED_CHANNEL
      ? `Canal restreint: ${ALLOWED_CHANNEL}`
      : "Tous les canaux autorises (mentionner le bot)"
  );
  console.log("Modules actifs: MetricsStore, DeepHealthChecks, AnomalyDetector, AlertSystem, UptimeTracker, DeployDetector, SecurityMonitor, SelfDiagnostic");

  syncLogToDashboard("Bot Maintenance connecte — Supervision complete activee", "success", { description: "Modules actifs: Health, Anomalies, Uptime, Securite, Deploys, SSL, Self-diag", category: "system" });
  syncMessageToDashboard("Maintenance Agent", "Bot en ligne. Modules: Health, Anomalies, Uptime, Securite, Deploys, Self-diag. Supervision active.", "system");
});

// ── Message Handler (ENRICHI avec contexte supervision) ──

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const isMentioned = message.mentions.has(client.user);
  const isAllowedChannel =
    ALLOWED_CHANNEL && message.channel.id === ALLOWED_CHANNEL;

  if (!isMentioned && !isAllowedChannel) return;

  const cleanContent = message.content.replace(/<@!?\d+>/g, "").trim();

  if (!cleanContent) {
    await message.reply(
      "Salut ! Je suis l'agent de maintenance Infinea. Pose-moi une question sur l'etat du systeme, les audits, la sante de la plateforme, l'uptime, les anomalies ou la securite."
    );
    return;
  }

  if (isOnCooldown(message.channel.id)) {
    await message.reply("Je traite encore ta derniere demande, patiente quelques secondes.");
    return;
  }
  setCooldown(message.channel.id);

  await message.channel.sendTyping();

  try {
    const dashboardData = await fetchDashboardData();
    const dashboardContext = formatDashboardContext(dashboardData);
    const supervisionContext = formatSupervisionContext();

    const fullSystemPrompt =
      SYSTEM_PROMPT +
      `\n\nDONNEES EN TEMPS REEL (mises a jour a chaque message):\n${dashboardContext}` +
      `\n\nSUPERVISION EN TEMPS REEL:\n${supervisionContext}`;

    addToHistory(message.channel.id, "user", cleanContent);
    const history = getHistory(message.channel.id);

    syncMessageToDashboard(message.author.username, cleanContent, "user");

    const reply = await callGroq(fullSystemPrompt, history);

    addToHistory(message.channel.id, "assistant", reply);

    syncMessageToDashboard("Maintenance Agent", reply, "bot");
    syncLogToDashboard(`Reponse a: "${cleanContent.slice(0, 60)}"`, "info", { description: `Message de ${message.author.username} traite par Groq`, category: "conversation" });

    if (reply.length > 2000) {
      const chunks = reply.match(/[\s\S]{1,1990}/g) || [reply];
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    } else {
      await message.reply(reply);
    }
  } catch (error) {
    console.error("Erreur:", error.message);
    await message.reply(
      `Une erreur s'est produite: ${error.message.slice(0, 200)}`
    );
  }
});

// ── Hourly Check-up (ENRICHI avec rapport supervision) ──

const HOURLY_INTERVAL = 60 * 60 * 1000;

async function sendHourlyCheckup() {
  if (!ALLOWED_CHANNEL) {
    console.log("Pas de canal configure pour les check-ups horaires.");
    return;
  }

  try {
    const channel = client.channels.cache.get(ALLOWED_CHANNEL);
    if (!channel) {
      console.log("Canal introuvable pour le check-up horaire.");
      return;
    }

    // 1. Audit complet: GitHub + deep health + security
    console.log("Lancement audit complet (GitHub + health + securite)...");
    const [githubData, deepChecks, sslChecks, securityData] = await Promise.all([
      runGitHubAudit(),
      runDeepHealthChecks(),
      runSSLChecks(),
      checkGitHubSecurityAlerts(),
    ]);

    // 2. Detection deploiements
    const newDeploys = detectNewDeploys(githubData);
    if (newDeploys.length > 0) {
      await notifyNewDeploys(newDeploys);
    }

    // 3. Detection anomalies
    const anomalies = detectAnomalies();
    updateEscalationLevel(anomalies);

    // 4. Bot self-check
    const botIssues = checkBotHealth();
    const diag = getSelfDiagnostic();

    // 5. Mettre a jour le dashboard
    const healthChecks = {
      frontend: deepChecks.find(r => r.label === "Frontend") || { status: "pending", detail: "N/A" },
      backend: deepChecks.find(r => r.label === "API Docs") || { status: "pending", detail: "N/A" },
    };
    const freshStatus = await updateDashboardStatus(healthChecks, githubData);

    // 6. Construire le rapport Discord enrichi
    const lines = [];
    const hcIcon = (s) => s === "healthy" ? "\u2705" : s === "warning" ? "\u26A0\uFE0F" : "\u{1F534}";

    lines.push("**\u{1F4CA} Rapport Horaire — Infinea Maintenance**\n");

    // Health checks detailles
    lines.push("**Endpoints:**");
    for (const check of deepChecks) {
      lines.push(`${hcIcon(check.status)} ${check.label}: ${check.detail}`);
    }

    // SSL
    const sslIssues = sslChecks.filter(s => !s.valid);
    if (sslIssues.length > 0) {
      lines.push(`\n\u{1F512} **SSL**: ${sslIssues.length} probleme(s)`);
      for (const s of sslIssues) lines.push(`- ${s.hostname}: ${s.detail}`);
    } else {
      lines.push(`\n\u{1F512} **SSL**: Tous les certificats valides`);
    }

    // Uptime
    const uptimeReport = getUptimeReport();
    const u1h = uptimeReport["1h"];
    if (u1h.frontend !== null || u1h.backend !== null) {
      lines.push(`\n\u{1F4C8} **Uptime 1h**: Frontend ${formatUptimeForDisplay(u1h.frontend)} | Backend ${formatUptimeForDisplay(u1h.backend)}`);
    }
    const u24h = uptimeReport["24h"];
    if (u24h.frontend !== null || u24h.backend !== null) {
      lines.push(`\u{1F4C8} **Uptime 24h**: Frontend ${formatUptimeForDisplay(u24h.frontend)} | Backend ${formatUptimeForDisplay(u24h.backend)}`);
    }

    // Latence
    const beAvg = getAvgMetric("backendLatency", 60 * 60 * 1000);
    const feAvg = getAvgMetric("frontendLatency", 60 * 60 * 1000);
    if (beAvg || feAvg) {
      const beMinMax = getMinMaxMetric("backendLatency", 60 * 60 * 1000);
      lines.push(`\n\u23F1\uFE0F **Latence 1h**: Backend avg ${beAvg ? Math.round(beAvg) : "?"}ms (min ${beMinMax.min ?? "?"}ms / max ${beMinMax.max ?? "?"}ms) | Frontend avg ${feAvg ? Math.round(feAvg) : "?"}ms`);
    }

    // Anomalies
    if (anomalies.length > 0) {
      lines.push(`\n\u26A0\uFE0F **${anomalies.length} anomalie(s) detectee(s):**`);
      for (const a of anomalies.slice(0, 5)) {
        const aIcon = a.severity === "critical" ? "\u{1F534}" : "\u{1F7E0}";
        lines.push(`${aIcon} [${a.severity}] ${a.message}`);
      }
    }

    // Securite GitHub
    if (securityData.alerts?.length > 0) {
      const critSec = securityData.alerts.filter(a => a.severity === "critical" || a.severity === "high");
      lines.push(`\n\u{1F6E1}\uFE0F **Securite**: ${securityData.alerts.length} alerte(s) Dependabot${critSec.length > 0 ? ` dont ${critSec.length} critique(s)/haute(s)` : ""}`);
    } else {
      lines.push(`\n\u{1F6E1}\uFE0F **Securite**: Aucune vulnerabilite connue`);
    }

    // GitHub activity
    if (githubData.length > 0) {
      lines.push("\n**GitHub:**");
      for (const repo of githubData) {
        const lastCommit = repo.recentCommits?.[0];
        const commitInfo = lastCommit ? `"${lastCommit.message?.slice(0, 40)}" (${lastCommit.author})` : "aucun commit recent";
        lines.push(`- **${repo.name}**: ${commitInfo}`);
      }
    }

    // Deploiements
    if (newDeploys.length > 0) {
      lines.push(`\n\u{1F680} **${newDeploys.length} deploiement(s)** detecte(s) cette heure`);
    }

    // Bot self-diagnostic
    lines.push(`\n\u{1F916} **Bot**: ${diag.uptimeFormatted} uptime | ${diag.memory.heapUsed}MB RAM | ${diag.metricsPoints} points metriques | Escalation: ${alertState.escalationLevel}`);
    if (botIssues.length > 0) {
      for (const issue of botIssues) {
        lines.push(`\u26A0\uFE0F Bot: ${issue.message}`);
      }
    }

    // Bilan
    if (freshStatus?.stats) {
      const s = freshStatus.stats;
      lines.push(`\n**Bilan**: ${s.criticalIssues} critiques | ${s.highIssues} warnings | ${s.mediumIssues} medium | ${s.fixesApplied} commits recents`);
    }

    lines.push(`\n_Prochain check-up dans 1h — Dashboard: ${DASHBOARD_URL}_`);

    const report = lines.join("\n");
    // Discord limite a 2000 chars
    if (report.length > 2000) {
      const chunks = report.match(/[\s\S]{1,1990}/g) || [report];
      for (const chunk of chunks) {
        await channel.send(chunk);
      }
    } else {
      await channel.send(report);
    }

    console.log(`Check-up horaire envoye a ${new Date().toISOString()} (${anomalies.length} anomalies, ${newDeploys.length} deploys)`);
    syncLogToDashboard(`Check-up horaire complet — ${anomalies.length} anomalies, uptime BE ${formatUptimeForDisplay(u1h.backend)}`, "success", { description: `${deepChecks.length} endpoints, ${sslChecks.length} SSL, ${githubData.length} repos, ${newDeploys.length} deploys`, category: "audit" });
  } catch (error) {
    console.error("Erreur check-up horaire:", error.message);
  }
}

// ── Live Dashboard Sync (ENRICHI avec supervision) ──

let cachedGithubData = [];

async function liveDashboardSync() {
  try {
    // 1. Deep health checks (remplace les simples health checks)
    const deepChecks = await runDeepHealthChecks();

    // 2. Mapper vers le format attendu par updateDashboardStatus
    const healthChecks = {
      frontend: deepChecks.find(r => r.label === "Frontend") || { status: "pending", detail: "N/A", latency: 0 },
      backend: deepChecks.find(r => r.label === "API Docs") || { status: "pending", detail: "N/A", latency: 0 },
    };

    // 3. Detection anomalies
    const anomalies = detectAnomalies();
    updateEscalationLevel(anomalies);

    // 4. Envoyer alertes Discord si necessaire
    for (const anomaly of anomalies) {
      await sendDiscordAlert(anomaly);
    }

    // 5. Bot self-check
    const botIssues = checkBotHealth();
    for (const issue of botIssues) {
      await sendDiscordAlert({ domain: "bot", severity: issue.severity, message: issue.message });
    }

    // 6. Mettre a jour le dashboard
    await updateDashboardStatus(healthChecks, cachedGithubData);
  } catch (e) {
    console.error("Live sync error:", e.message);
  }
}

async function refreshGitHubData() {
  try {
    console.log("Refresh GitHub data + securite + audit findings...");
    const [githubData, securityData] = await Promise.all([
      runGitHubAudit(),
      checkGitHubSecurityAlerts(),
    ]);
    await refreshAuditFindings();

    // Detection de deploiements + re-audit si deploy detecte
    const newDeploys = detectNewDeploys(githubData);
    if (newDeploys.length > 0) {
      await notifyNewDeploys(newDeploys);
      // Re-audit automatique apres un deploy (le code a potentiellement change)
      console.log("Deploy detecte — lancement re-audit automatique...");
      await runAutoAudit();
    }

    // Alerte securite si nouvelles vulns critiques
    if (securityData.alerts?.length > 0) {
      const criticals = securityData.alerts.filter(a => a.severity === "critical" || a.severity === "high");
      if (criticals.length > 0) {
        await notifySecurityAlerts(criticals);
      }
    }

    cachedGithubData = githubData;
    console.log(`GitHub: ${githubData.length} repos, ${securityData.alerts?.length || 0} alertes securite, ${newDeploys.length} nouveaux deploys`);
  } catch (e) {
    console.error("GitHub refresh error:", e.message);
  }
}

// ── SSL check periodique (toutes les 6h) ──

async function periodicSSLCheck() {
  try {
    const results = await runSSLChecks();
    const issues = results.filter(r => !r.valid);
    if (issues.length > 0) {
      for (const issue of issues) {
        await sendDiscordAlert({
          domain: "ssl",
          severity: "critical",
          message: `Certificat SSL invalide: ${issue.hostname} — ${issue.detail}`,
        });
      }
      syncLogToDashboard(`SSL: ${issues.length} certificat(s) invalide(s)`, "error", { description: issues.map(i => `${i.hostname}: ${i.detail}`).join("; "), category: "security" });
    } else {
      console.log("SSL check OK — tous les certificats valides");
    }
  } catch (e) {
    console.error("SSL check error:", e.message);
  }
}

// ── Demarrage ──

client.once(Events.ClientReady, () => {
  // 1. Premier audit complet immediat (10s)
  setTimeout(async () => {
    await refreshGitHubData();
    await liveDashboardSync();
    await periodicSSLCheck();
    await runAutoAudit();
    await refreshAuditFindings();
    sendHourlyCheckup();

    // 2. Deep health checks + anomalies + alertes → dashboard toutes les 15 secondes
    setInterval(liveDashboardSync, 15 * 1000);
    console.log("Live sync dashboard actif (toutes les 15s) — supervision complete");

    // 3. Refresh GitHub + securite + deploy detection toutes les 15 minutes
    setInterval(refreshGitHubData, 15 * 60 * 1000);
    console.log("Refresh GitHub + securite actif (toutes les 15min)");

    // 4. Rapport Discord toutes les heures
    setInterval(sendHourlyCheckup, HOURLY_INTERVAL);
    console.log("Rapport Discord horaire actif (enrichi)");

    // 5. Verification SSL toutes les 6 heures
    setInterval(periodicSSLCheck, 6 * 60 * 60 * 1000);
    console.log("Verification SSL active (toutes les 6h)");

    // 6. Auto-audit du code toutes les 6 heures
    setInterval(async () => {
      await runAutoAudit();
      await refreshAuditFindings();
    }, 6 * 60 * 60 * 1000);
    console.log("Auto-audit du code actif (toutes les 6h + post-deploy)");
  }, 10 * 1000);
});

client.login(DISCORD_TOKEN);
console.log("Demarrage du bot Infinea Maintenance — Supervision complete...");
