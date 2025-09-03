// -----------------------------------------------------------------------------
// 1. DEPENDÊNCIAS E CONFIGURAÇÃO INICIAL
// -----------------------------------------------------------------------------
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const axios = require("axios");
const NodeCache = require("node-cache");
const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");
require("dotenv").config();
const express = require("express");
const app = express();

// --- ATENÇÃO ---
// É uma MÁ PRÁTICA de segurança colocar o token diretamente no código.
// Considere usar variáveis de ambiente (ex: process.env.DISCORD_TOKEN).
const BOT_TOKEN = process.env.DISCORD_TOKEN;
const port = process.env.PORT || 3000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const PREFIX = "!";
const cache = new NodeCache({ stdTTL: 3600 }); // Cache de 1 hora

// -----------------------------------------------------------------------------
// 2. EVENTOS DO BOT
// -----------------------------------------------------------------------------

// Evento que dispara quando o bot está online e pronto
client.on("clientReady", () => {
  console.log(`Bot logado como ${client.user.tag}`);
});

// Evento que dispara a cada mensagem recebida
client.on("messageCreate", async (message) => {
  if (!message.content.startsWith(PREFIX) || message.author.bot) return;

  const [command, ...args] = message.content
    .trim()
    .substring(PREFIX.length)
    .split(/\s+/);

  if (command.toLowerCase() === "pokemon") {
    const pokemonName = args.join(" ").toLowerCase();
    if (!pokemonName)
      return message.reply("Por favor, informe o nome do Pokémon.");

    const waitingMessage = await message.reply(`🔍 Buscando informações para **${pokemonName}**, isso pode demorar um pouco...`);

    try {
      await message.channel.sendTyping();
      const info = await getPokemonInfo(pokemonName);

      // Filtra apenas as builds que têm habilidades (moves) preenchidas
      const validBuilds = info.builds.filter(
        (build) => build.moves && build.moves.length > 0
      );

      if (validBuilds.length === 0) {
        return message.reply(
          `Não foi possível carregar builds para "${pokemonName}". Tente novamente mais tarde.`
        );
      }

      const embeds = validBuilds.map((build) => {
        const embed = new EmbedBuilder()
          .setAuthor({ name: `${info.name} - ${info.damageType}` })
          .setTitle(build.buildName)
          .setDescription(build.path || " ")
          .setColor(0xffcb05)
          .addFields(
            {
              name: "⚔️ Habilidades (Moves)",
              value: build.moves
                .map((m) => `**${m.name}** (${m.level})`)
                .join("\n"),
              inline: true,
            },
            {
              name: "🎒 Itens (Held Items)",
              value: build.heldItems.map((i) => i.name).join("\n"),
              inline: true,
            }
          );

        if (info.image) embed.setThumbnail(info.image);

        if (build.battleItem && build.battleItem.name) {
          embed.addFields({
            name: "⚡ Item de Batalha",
            value: build.battleItem.name,
            inline: false,
          });
        }

        if (build.emblemLoadout) {
          embed.addFields({
            name: "🛡️ Emblemas",
            value: `[Ver configuração](${build.emblemLoadout})`,
            inline: false,
          });
        }

        return embed;
      });

      // Envia as builds que foram carregadas corretamente
      await waitingMessage.delete(); 

      await message.channel.send({
        content: `Encontrei ${embeds.length} build(s) principal(is) para **${info.name}**:`,
        embeds: embeds,
      });

      // Se existirem builds adicionais não mostradas, avisa o usuário
      if (info.builds.length > validBuilds.length) {
        await message.channel.send({
          content: `Foram encontradas outras combinações de builds no site.\nPara ver todas as possibilidades, acesse: https://unite-db.com/pokemon/${pokemonName}`,
        });
      }
    } catch (err) {
      console.error(err);
      await waitingMessage.edit("Ocorreu um erro ao buscar as informações do Pokémon.");
    }
  }
});

// -----------------------------------------------------------------------------
// 3. FUNÇÃO DE SCRAPING E LÓGICA PRINCIPAL
// -----------------------------------------------------------------------------

async function getPokemonInfo(name) {
    name = name.toLowerCase();
    const cached = cache.get(name);
    if (cached) {
      console.log(`Retornando dados de '${name}' do cache.`);
      return cached;
    }
  
    let apiData = null;
    try {
      const res = await axios.get(`https://uniteapi.dev/p/${name}?type=auto`);
      apiData = res.data;
      console.log(`Dados de '${name}' obtidos da API.`);
    } catch (err) {
      console.log(
        "API não retornou dados. Prosseguindo com scraping no Unite-DB."
      );
    }
  
    let scrapedBuilds = [];
    let scrapedGeneralInfo = {
        damageType: "Não especificado"
    };
    let browser;
    let page;
  
    try {
      console.log(`Iniciando scraping para '${name}' no Unite-DB...`);
      browser = await puppeteer.launch({
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
        ignoreHTTPSErrors: true,
      });
      
      page = await browser.newPage();
      await page.setViewport({ width: 1366, height: 900 });
  
      const url = `https://unite-db.com/pokemon/${name}`;
      console.log(`Navegando para: ${url}`);
      await page.goto(url, { waitUntil: "networkidle2", timeout: 150000 });
  
      // --- ETAPA 1: Capturar informações estáticas primeiro ---
      console.log("Capturando informações gerais (nome, tipo de dano)...");
      await page.waitForSelector(".character-info .damage-wrapper h3", { timeout: 150000 });
      
      scrapedGeneralInfo = await page.evaluate(() => {
          return {
              damageType: document.querySelector('.damage-wrapper > h3')?.textContent.trim() || 'Não especificado'
          };
      });
      console.log(`Tipo de Dano encontrado: ${scrapedGeneralInfo.damageType}`);
  
      // --- ETAPA 2: Interagir com a página e esperar pelo conteúdo dinâmico ---
      const buildsTabSelector = "#app > div.container > section > ul > li:nth-child(2)";
      await page.waitForSelector(buildsTabSelector, { timeout: 150000 });
      await page.click(buildsTabSelector);
  
      console.log("Aguardando todas as builds serem renderizadas...");
      await page.waitForFunction(
        () => {
          const buildContainers = document.querySelectorAll("div.details.builds div.build");
          return (
            buildContainers.length > 0 &&
            Array.from(buildContainers).every((build) =>
              build.querySelector(".selected-abilities .ability-icon")
            )
          );
        },
        { timeout: 150000 }
      );
      console.log("Todas as builds foram carregadas.");
  
      // --- ETAPA 3: Capturar as informações das builds ---
      scrapedBuilds = await page.evaluate(() => {
          const normalizeName = (s) => {
              if (!s) return "";
              return s.replace(/-/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
          };
  
          const buildEls = document.querySelectorAll("div.details.builds div.build");
          const builds = [];
  
          buildEls.forEach((buildEl) => {
              const build = {
                  buildName: buildEl.querySelector("h3.title")?.textContent.trim(),
                  path: buildEl.querySelector("p.lane")?.textContent.trim(),
                  moves: [],
                  heldItems: [],
                  battleItem: null,
                  emblemLoadout: "",
              };
  
              buildEl.querySelectorAll(".selected-abilities .ability").forEach((moveEl) => {
                  const img = moveEl.querySelector(".ability-icon");
                  const level = moveEl.querySelector("p.level")?.textContent.trim();
                  if (img && img.src) {
                      const fileName = img.src.split("/").pop();
                      const moveName = decodeURIComponent(fileName).replace(".png", "").trim();
                      build.moves.push({ name: moveName, level: level });
                  }
              });
  
              buildEl.querySelectorAll(".wrapper.held:not(.optional) section.item").forEach((itemEl) => {
                  const href = itemEl.querySelector("a.item-name")?.href;
                  if (href) build.heldItems.push({ name: normalizeName(href.split("/").pop()) });
              });
  
              const battleItemElement = buildEl.querySelector(".wrapper.battle:not(.optional) section.item a.item-name");
              if (battleItemElement) {
                  build.battleItem = { name: normalizeName(battleItemElement.href.split("/").pop()) };
              }
  
              const emblemLink = buildEl.querySelector(".emblem-loadout a");
              if (emblemLink) build.emblemLoadout = emblemLink.href;
  
              builds.push(build);
          });
  
          return builds;
      });
  
    } catch (err) {
      console.error(`Erro no scraping para '${name}':`, err.message);
    } finally {
      if (browser) await browser.close();
    }
    
    const finalInfo = {
      name: apiData?.name || (name.charAt(0).toUpperCase() + name.slice(1)),
      role: apiData?.role || "Não especificado",
      damageType: scrapedGeneralInfo.damageType, 
      image: apiData?.assets?.icon || "",
      builds: scrapedBuilds || [],
    };
  
    cache.set(name, finalInfo);
    return finalInfo;
  }

// -----------------------------------------------------------------------------
// 4. LOGIN DO BOT
// -----------------------------------------------------------------------------
client.login(BOT_TOKEN);

app.get("/", (req, res) => {
  res.send("Hello World");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})