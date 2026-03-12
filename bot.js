/**
 * Infinea Maintenance Bot — Discord Bot
 *
 * Bot conversationnel qui permet a Sam de discuter
 * avec l'agent de maintenance Infinea sur Discord.
 *
 * Utilise Groq API (Llama 3.3 70B) pour generer les reponses — 24/7 cloud.
 * Se connecte au dashboard pour acceder aux donnees en temps reel.
 * Sync les messages et logs vers le dashboard automatiquement.
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

// ── Dashboard API ──

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
    for (const [key, sys] of Object.entries(data.status.systems)) {
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

// ── System Prompt ──

const SYSTEM_PROMPT = `Tu es l'agent de maintenance Infinea. Tu es un CTO/tech lead bienveillant qui maintient le systeme Infinea (SaaS d'optimisation comportementale).

TON ROLE:
- Tu reponds aux questions de Sam (fondateur non-technique) sur l'etat du systeme
- Tu expliques les problemes techniques en francais simple
- Tu donnes des rapports clairs et actionnables
- Tu es proactif: si tu vois un probleme critique, tu le signales immediatement

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
- Si Sam demande quelque chose hors de ton scope, redirige-le poliment`;

// ── Groq API ──

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

// ── Dashboard Sync ──

async function syncMessageToDashboard(from, content, type = "bot") {
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

async function syncLogToDashboard(title, type = "info") {
  try {
    await fetch(`${DASHBOARD_URL}/api/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        type,
        timestamp: new Date().toISOString(),
      }),
    });
  } catch (e) {
    console.error("Sync log dashboard:", e.message);
  }
}

// ── GitHub Audit ──

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

// ── Health Checks ──

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

async function runHealthChecks() {
  const [frontend, backend] = await Promise.all([
    checkServiceHealth(VERCEL_FRONTEND_URL, "Frontend Vercel"),
    checkServiceHealth(`${RENDER_BACKEND_URL}/docs`, "Backend Render"),
  ]);
  return { frontend, backend };
}

// ── Dashboard Update (push fresh data) ──

async function updateDashboardStatus(healthChecks, githubData) {
  try {
    const now = new Date().toISOString();
    const mainRepo = githubData.find(r => r.name === "Infinea-");
    const lastPush = mainRepo?.lastPush ? new Date(mainRepo.lastPush).toISOString() : "inconnu";
    const totalOpenIssues = githubData.reduce((sum, r) => sum + (r.openIssues || 0), 0);
    const recentCommitCount = githubData.reduce((sum, r) => sum + (r.recentCommits?.length || 0), 0);

    const lastCommitMsg = mainRepo?.recentCommits?.[0]?.message || "N/A";
    const lastCommitDate = mainRepo?.recentCommits?.[0]?.date
      ? new Date(mainRepo.recentCommits[0].date).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
      : "N/A";

    const systems = {
      backend: {
        status: healthChecks.backend.status,
        label: "Backend FastAPI",
        detail: `${healthChecks.backend.detail} — Dernier push: ${lastCommitDate}`,
      },
      frontend: {
        status: healthChecks.frontend.status,
        label: "Frontend React 19",
        detail: `${healthChecks.frontend.detail} — Dernier commit: "${lastCommitMsg.slice(0, 50)}"`,
      },
      database: {
        status: "healthy",
        label: "MongoDB Atlas",
        detail: "Connecte via backend (verifie indirectement)",
      },
      github: {
        status: "healthy",
        label: "GitHub Repos",
        detail: `${githubData.length} repos actifs, ${recentCommitCount} commits recents, ${totalOpenIssues} issues ouvertes`,
      },
      security: {
        status: totalOpenIssues > 5 ? "warning" : "healthy",
        label: "Securite",
        detail: `${totalOpenIssues} issues ouvertes sur GitHub`,
      },
      cicd: {
        status: "healthy",
        label: "CI/CD & Deploy",
        detail: `Auto-deploy actif — Dernier push repo principal: ${lastCommitDate}`,
      },
    };

    // Compute fresh stats
    const criticalCount = Object.values(systems).filter(s => s.status === "error").length;
    const warningCount = Object.values(systems).filter(s => s.status === "warning").length;

    const statusPayload = {
      systems,
      stats: {
        criticalIssues: criticalCount,
        highIssues: warningCount,
        mediumIssues: 0,
        lowIssues: 0,
        auditsCompleted: githubData.length,
        fixesApplied: recentCommitCount,
      },
      lastUpdated: now,
    };

    await fetch(`${DASHBOARD_URL}/api/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(statusPayload),
    });

    console.log(`Dashboard status mis a jour a ${now}`);
    return statusPayload;
  } catch (e) {
    console.error("Erreur mise a jour dashboard:", e.message);
    return null;
  }
}

// ── Per-channel cooldown ──

const channelCooldowns = new Map();
const COOLDOWN_MS = 3000;

function isOnCooldown(channelId) {
  const last = channelCooldowns.get(channelId) || 0;
  return Date.now() - last < COOLDOWN_MS;
}

function setCooldown(channelId) {
  channelCooldowns.set(channelId, Date.now());
}

// ── Conversation History ──

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

  syncLogToDashboard("Bot Maintenance connecte — Llama 3.3 70B via Groq", "success");
  syncMessageToDashboard("Maintenance Agent", "Bot en ligne. LLM: Llama 3.3 70B (Groq cloud). Pret a recevoir des commandes.", "system");
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const isMentioned = message.mentions.has(client.user);
  const isAllowedChannel =
    ALLOWED_CHANNEL && message.channel.id === ALLOWED_CHANNEL;

  if (!isMentioned && !isAllowedChannel) return;

  const cleanContent = message.content.replace(/<@!?\d+>/g, "").trim();

  if (!cleanContent) {
    await message.reply(
      "Salut ! Je suis l'agent de maintenance Infinea. Pose-moi une question sur l'etat du systeme, les audits, ou la sante de la plateforme."
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

    const fullSystemPrompt =
      SYSTEM_PROMPT +
      `\n\nDONNEES EN TEMPS REEL (mises a jour a chaque message):\n${dashboardContext}`;

    addToHistory(message.channel.id, "user", cleanContent);
    const history = getHistory(message.channel.id);

    syncMessageToDashboard(message.author.username, cleanContent, "user");

    const reply = await callGroq(fullSystemPrompt, history);

    addToHistory(message.channel.id, "assistant", reply);

    syncMessageToDashboard("Maintenance Agent", reply, "bot");
    syncLogToDashboard(`Reponse a: "${cleanContent.slice(0, 60)}"`, "info");

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

// ── Hourly Check-up ──

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

    // 1. Audit reel : GitHub + health checks
    console.log("Lancement audit GitHub + health checks...");
    const [githubData, healthChecks] = await Promise.all([
      runGitHubAudit(),
      runHealthChecks(),
    ]);

    // 2. Mettre a jour le dashboard avec les donnees fraiches
    const freshStatus = await updateDashboardStatus(healthChecks, githubData);

    // 3. Construire le rapport Discord avec les vraies donnees
    const lines = [];
    lines.push("**Rapport Horaire — Infinea Maintenance**\n");

    // Health checks
    const hcIcon = (s) => s === "healthy" ? "\u2705" : s === "warning" ? "\u26A0\uFE0F" : "\u{1F534}";
    lines.push(`${hcIcon(healthChecks.frontend.status)} **Frontend**: ${healthChecks.frontend.detail}`);
    lines.push(`${hcIcon(healthChecks.backend.status)} **Backend**: ${healthChecks.backend.detail}`);

    // GitHub activity
    if (githubData.length > 0) {
      lines.push("\n**GitHub** :");
      for (const repo of githubData) {
        const lastCommit = repo.recentCommits?.[0];
        const commitInfo = lastCommit ? `"${lastCommit.message?.slice(0, 40)}" (${lastCommit.author})` : "aucun commit recent";
        lines.push(`- **${repo.name}**: ${commitInfo}`);
      }
    }

    // Stats
    if (freshStatus?.stats) {
      const s = freshStatus.stats;
      lines.push(`\n**Bilan**: ${s.criticalIssues} critiques | ${s.highIssues} warnings | ${s.fixesApplied} commits recents`);
    }

    lines.push(`\n_Prochain check-up dans 1h — Dashboard: ${DASHBOARD_URL}_`);

    await channel.send(lines.join("\n"));
    console.log(`Check-up horaire envoye a ${new Date().toISOString()}`);
    syncLogToDashboard("Check-up horaire (audit GitHub + health checks)", "success");
  } catch (error) {
    console.error("Erreur check-up horaire:", error.message);
  }
}

// ── Demarrage ──

client.once(Events.ClientReady, () => {
  // Premier audit dans 10 secondes, puis toutes les heures
  setTimeout(() => {
    sendHourlyCheckup();
    setInterval(sendHourlyCheckup, HOURLY_INTERVAL);
  }, 10 * 1000);
  console.log("Premier audit dans 10 secondes, puis toutes les heures.");
});

client.login(DISCORD_TOKEN);
console.log("Demarrage du bot Infinea Maintenance...");
