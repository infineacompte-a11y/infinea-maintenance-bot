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

    const dashboardData = await fetchDashboardData();
    const ctx = dashboardData;

    const lines = [];
    lines.push("**Rapport Horaire — Infinea Maintenance**\n");

    if (ctx.status?.systems) {
      const icons = { healthy: "\u2705", warning: "\u26A0\uFE0F", critical: "\u{1F534}", auditing: "\u{1F50D}", pending: "\u23F3" };
      for (const [key, sys] of Object.entries(ctx.status.systems)) {
        lines.push(`${icons[sys.status] || "\u2753"} **${sys.label}**: ${sys.detail}`);
      }
    }

    if (ctx.status?.stats) {
      const s = ctx.status.stats;
      lines.push(`\n**Compteurs**: ${s.criticalIssues || 0} critiques | ${s.highIssues || 0} high | ${s.mediumIssues || 0} medium | ${s.fixesApplied || 0} corrections`);
    }

    if (ctx.recentLogs?.length > 0) {
      lines.push("\n**Activite recente**:");
      for (const log of ctx.recentLogs.slice(0, 3)) {
        lines.push(`- ${log.title}`);
      }
    }

    lines.push(`\n_Prochain check-up dans 1h — Dashboard: ${DASHBOARD_URL}_`);

    await channel.send(lines.join("\n"));
    console.log(`Check-up horaire envoye a ${new Date().toISOString()}`);
    syncLogToDashboard("Check-up horaire envoye sur Discord", "success");
    syncMessageToDashboard("Maintenance Agent", "Check-up horaire envoye sur Discord.", "system");
  } catch (error) {
    console.error("Erreur check-up horaire:", error.message);
  }
}

// ── Demarrage ──

client.once(Events.ClientReady, () => {
  setTimeout(() => {
    sendHourlyCheckup();
    setInterval(sendHourlyCheckup, HOURLY_INTERVAL);
  }, 5 * 60 * 1000);
  console.log("Check-ups horaires programmes (premier dans 5 min, puis toutes les heures).");
});

client.login(DISCORD_TOKEN);
console.log("Demarrage du bot Infinea Maintenance...");
