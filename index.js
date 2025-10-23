// index.js
require('dotenv').config(); // Carrega as variáveis do .env
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { PrismaClient } = require('@prisma/client');
const { Client, GatewayIntentBits, Partials, ChannelType } = require('discord.js');

const app = express();
const prisma = new PrismaClient();
const bot = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel]
});
// Compatibilidade fetch no Node.js (CJS)
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Pasta pública (inclui/uploads)
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// Certifique-se que a pasta existe
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// armazenamento de multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = `${Date.now()}-${Math.random().toString(36).slice(2,8)}${ext}`;
    cb(null, name);
  }
});
const upload = multer({ storage });

// --- CONFIGURAÇÃO ---
let CONFIG = {
  mainChannelId: '',
  mainMessageId: '',
  deliveryChannelId: '',
  clientRoleId: '',
  guildId: '',
  isManagedExternally: false // Flag para indicar se a config é externa
};

async function loadConfig() {
  // Prioriza variáveis de ambiente (usadas no Render)
  const envMainChannelId = process.env.MAIN_CHANNEL_ID;
  const envDeliveryChannelId = process.env.DELIVERY_CHANNEL_ID;

  if (envMainChannelId && envDeliveryChannelId) {
    console.log('Carregando configurações a partir das variáveis de ambiente (Render).');
    CONFIG.mainChannelId = envMainChannelId;
    CONFIG.deliveryChannelId = envDeliveryChannelId;
    CONFIG.mainMessageId = process.env.MAIN_MESSAGE_ID || null;
    CONFIG.clientRoleId = process.env.CLIENT_ROLE_ID || null;
    CONFIG.guildId = process.env.GUILD_ID || null;
    CONFIG.isManagedExternally = true;
  } else {
    // Fallback para o banco de dados (para desenvolvimento local)
    console.log('Carregando configurações a partir do banco de dados.');
    try {
      const savedConfig = await prisma.configuration.findUnique({
        where: { id: 1 },
      });
      if (savedConfig) {
        CONFIG = { ...CONFIG, ...savedConfig, isManagedExternally: false };
      } else {
        await prisma.configuration.create({ data: { id: 1 } });
        console.log('Nenhuma configuração encontrada. Criada entrada padrão no banco de dados.');
      }
    } catch (e) {
      console.error('Erro ao carregar configurações do banco de dados:', e);
    }
  }
}

async function saveConfig() {
  // Não salva no DB se a configuração for externa
  if (CONFIG.isManagedExternally) {
    console.log('Configurações gerenciadas por variáveis de ambiente. O salvamento no banco de dados foi ignorado.');
    return;
  }
  await prisma.configuration.upsert({
    where: { id: 1 },
    update: { ...CONFIG },
    create: { id: 1, ...CONFIG },
  });
}

// Estoque padrão (usado para popular o banco de dados na primeira execução)
const defaultStock = [
  { id: "TOMATRIO", name: "TOMATRIO", emoji: "🍅", quantity: 202, price: 0.50, max: 300 },
  { id: "MANGO", name: "MANGO", emoji: "🥭", quantity: 260, price: 0.70, max: 300 },
  { id: "MR_CARROT", name: "MR CARROT", emoji: "🥕", quantity: 74, price: 0.40, max: 150 },
  { id: "PLANTA", name: "PLANTA (100k ~ 500k DPS)", emoji: "🌱", quantity: 12, price: 7.50, max: 20 }
];

// Função para popular o banco de dados com o estoque padrão se estiver vazio
async function seedDatabase() {
  const itemCount = await prisma.stockItem.count();
  if (itemCount === 0) {
    console.log('Banco de dados de estoque vazio. Populando com dados padrão...');
    await prisma.stockItem.createMany({
      data: defaultStock,
    });
    console.log('Banco de dados populado.');
  }
}

// ---------- endpoints API ---------- //

// Get/Save Config
app.get('/get-config', (req, res) => {
  res.json(CONFIG);
});

app.post('/save-config', async (req, res) => {
  const { mainChannelId, deliveryChannelId, mainMessageId, clientRoleId, guildId } = req.body;
  if (mainChannelId !== undefined) CONFIG.mainChannelId = mainChannelId;
  if (deliveryChannelId !== undefined) CONFIG.deliveryChannelId = deliveryChannelId;
  if (mainMessageId !== undefined) CONFIG.mainMessageId = mainMessageId;
  if (clientRoleId !== undefined) CONFIG.clientRoleId = clientRoleId;
  if (guildId !== undefined) CONFIG.guildId = guildId;
  await saveConfig();
  console.log('Configurações salvas:', CONFIG);
  res.json({ status: 'success', message: 'Configurações salvas.' });
});

// Get stock (front-end)
app.get('/get-stock', async (req, res) => {
  const stock = await prisma.stockItem.findMany({ orderBy: { name: 'asc' } });
  res.json(stock);
});

// Add new fruit (creates entry in stock.json and returns updated list)
app.post('/add-fruit', async (req, res) => {
  const { id, name, emoji, price, quantity, max } = req.body;
  if (!id || !name) return res.status(400).json({ status: 'error', message: 'id e name obrigatórios' });

  const existingItem = await prisma.stockItem.findUnique({ where: { id: String(id).toUpperCase().replace(/\s+/g, '_') } });
  if (existingItem) {
    return res.status(400).json({ status: 'error', message: 'ID já existe' });
  }

  const newItemData = {
    id: String(id).toUpperCase().replace(/\s+/g, '_'),
    name: name.toUpperCase(),
    emoji: emoji || '',
    price: Number(price) || 0,
    quantity: Number(quantity) || 0,
    max: Number(max) || (Number(quantity) || 100)
  };

  const item = await prisma.stockItem.create({ data: newItemData });
  const stock = await prisma.stockItem.findMany({ orderBy: { name: 'asc' } });
  return res.json({ status: 'success', stock, item });
});

// Update stock/prices (from panel)
app.post('/update-stock', async (req, res) => {
  try {
    const newStockData = req.body; // keys like TOMATRIO_quantity, TOMATRIO_price
    const currentStock = await prisma.stockItem.findMany({ select: { id: true } });

    const updateOperations = currentStock
      .map(item => {
        const quantityKey = `${item.id}_quantity`;
        const priceKey = `${item.id}_price`;
        const dataToUpdate = {};

        if (newStockData[quantityKey] !== undefined) {
          dataToUpdate.quantity = parseInt(newStockData[quantityKey], 10);
        }
        if (newStockData[priceKey] !== undefined) {
          // Use o tipo Decimal do Prisma, que espera uma string ou número
          dataToUpdate.price = parseFloat(newStockData[priceKey]);
        }

        if (Object.keys(dataToUpdate).length > 0) {
          return prisma.stockItem.update({ where: { id: item.id }, data: dataToUpdate });
        }
        return null;
      })
      .filter(Boolean); // Remove nulls from the array

    await prisma.$transaction(updateOperations);

    // Se o canal de estoque estiver configurado, cria ou atualiza o embed.
    if (CONFIG.mainChannelId) {
      try {
        const message = await updateMainEmbed();
        // Se uma nova mensagem foi criada, salva seu ID.
        if (message && !CONFIG.mainMessageId) {
          CONFIG.mainMessageId = message.id;
          await saveConfig();
          console.log(`Nova mensagem de estoque criada com ID: ${message.id}`);
        }
      } catch (err) { console.error('Erro ao criar/atualizar embed principal:', err); }
    }
    
    const updatedStock = await prisma.stockItem.findMany({ orderBy: { name: 'asc' } });
    res.json({ status: 'success', stock: updatedStock });
  } catch (error) {
    console.error('Erro ao atualizar o estoque:', error);
    res.status(500).json({ status: 'error', message: 'Falha ao atualizar o estoque.' });
  }
});

// Deliveries: create delivery (with optional file upload)
// Fields expected: webhook (delivery webhook URL), mention (string), itemId, quantity, note (optional)
// multipart/form-data with file field 'photo' (optional)
app.post('/deliver', upload.single('photo'), async (req, res) => {
  try {
    const { mention, itemId, quantity, note } = req.body;
    if (!CONFIG.deliveryChannelId) return res.status(400).json({ status: 'error', message: 'Canal de entregas não configurado no painel.' });
    if (!itemId) return res.status(400).json({ status: 'error', message: 'itemId requerido' });

    const item = await prisma.stockItem.findUnique({ where: { id: itemId } });
    if (!item) return res.status(400).json({ status: 'error', message: 'item não encontrado' });

    const qty = Number(quantity) || 1;

    // save photo URL if uploaded
    let photoUrl = null;
    if (req.file) {
      photoUrl = `${getServerBaseUrl(req)}/uploads/${req.file.filename}`;
    }

    // build embed payload for delivery
    const embed = {
      title: '📦 Entrega Confirmada',
      color: 3066993,
      thumbnail: photoUrl ? { url: photoUrl } : undefined,
      fields: [
        { name: 'Destinatário', value: mention || 'Não informado', inline: true },
        { name: 'Produto', value: `${item.emoji} ${item.name}`, inline: true },
        { name: 'Quantidade', value: String(qty), inline: true },
        { name: 'Preço Unit.', value: `R$${item.price.toFixed(2)}`, inline: true },
      ],
      description: note ? `${note}` : undefined,
      footer: { text: 'DOLLYA STORE — Entrega' }
    };

    // Para a menção funcionar, ela precisa estar no campo "content".
    // Também verificamos se o usuário digitou um ID numérico e o formatamos corretamente.
    let content = mention || '';
    if (/^\d{17,19}$/.test(content)) {
      content = `<@${content}>`;
    }

    // Monta o corpo da mensagem para o bot
    const body = {
      content: content,
      embeds: [embed]
    };

    // Envia a mensagem usando o bot
    const sentMessage = await sendMessageWithBot(CONFIG.deliveryChannelId, null, body);

    // save delivery log to database
    const deliveryRecord = await prisma.deliveryRecord.create({
      data: {
        mention: mention || null,
        itemId,
        itemName: item.name,
        quantity: qty,
        photoUrl,
        messageSent: !!sentMessage,
        messageStatus: sentMessage ? 200 : 500 // Simula um status de sucesso/falha
      }
    });

    res.json({ status: 'success', delivery: deliveryRecord });
  } catch (err) {
    console.error('Erro em /deliver:', err);
    res.status(500).json({ status: 'error', message: String(err) });
  }
});

// Get deliveries history
app.get('/get-deliveries', async (req, res) => {
  const deliveries = await prisma.deliveryRecord.findMany({ orderBy: { timestamp: 'desc' } });
  res.json(deliveries);
});

// Serve frontend
app.use(express.static('public'));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---------- helper functions ---------- //

// get base url from request
function getServerBaseUrl(req) {
  // If behind proxy, you might want to use X-Forwarded-Proto/header; this is a simple approach
  const host = req.get('host');
  const proto = req.protocol;
  return `${proto}://${host}`;
}

/**
 * Envia ou edita uma mensagem em um canal do Discord usando o bot.
 * @param {string} channelId O ID do canal.
 * @param {string|null} messageId O ID da mensagem para editar. Se for nulo, uma nova mensagem será enviada.
 * @param {object} body O corpo da mensagem (compatível com a API do Discord).
 * @returns {Promise<import('discord.js').Message|null>} A mensagem enviada/editada ou nulo em caso de erro.
 */
async function sendMessageWithBot(channelId, messageId, body) {
  if (!bot.isReady()) {
    console.error('Bot não está pronto para enviar mensagens.');
    return null;
  }
  try {
    const channel = await bot.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      console.error(`Canal ${channelId} não encontrado ou não é um canal de texto.`);
      return null;
    }
    return messageId ? await channel.messages.edit(messageId, body) : await channel.send(body);
  } catch (error) {
    console.error(`Erro ao interagir com a API do Discord no canal ${channelId}:`, error);
    return null;
  }
}
// generate main embed from stock (if you want to update the main store embed)
async function generateMainEmbed() {
  const stock = await prisma.stockItem.findMany({ orderBy: { name: 'asc' } });
  return {
    username: "DOLLYA VS BRAINROTS [PREÇOS]",
    avatar_url: "", // optional
    embeds: [{
      title: "🧠 DOLLYA STORE | TABELA DE PREÇOS",
      color: 16753920,
      fields: stock.map(item => ({
        name: `${item.emoji} ${item.name}`,
        value: `**Preço:** R$${item.price.toFixed(2)}\n**Estoque:** ${item.quantity > 0 ? item.quantity : 'ESGOTADO'}`,
        inline: true
      })),
      footer: { text: '🛒 DOLLYA STORE' }
    }],
    components: [
      {
        type: 1, // Action Row
        components: [
          {
            type: 2, // Button
            style: 3, // Success (verde)
            label: '🛒 Comprar',
            custom_id: 'buy_item_button'
          }
        ]
      }
    ]
  };
}

// update the main embed (if configured)
async function updateMainEmbed() {
  if (!CONFIG.mainChannelId) {
    console.log('Canal principal não configurado; pulando updateMainEmbed.');
    return null;
  }
  try {
    const body = await generateMainEmbed();
    // Remove username/avatar_url que são específicos de webhooks
    delete body.username;
    delete body.avatar_url;
    
    let message = null;
    try {
      // Tenta editar a mensagem se um ID existir
      if (CONFIG.mainMessageId) {
        message = await sendMessageWithBot(CONFIG.mainChannelId, CONFIG.mainMessageId, body);
      }
    } catch (error) {
      // Se a edição falhar (ex: mensagem não existe ou permissão negada), cria uma nova.
      if (error.code === 10008 || error.code === 50005) { // 10008: Unknown Message, 50005: Cannot edit another user's message
        console.warn(`Não foi possível editar a mensagem ${CONFIG.mainMessageId}. Criando uma nova.`);
        CONFIG.mainMessageId = null; // Limpa o ID inválido
      } else {
        throw error; // Lança outros erros
      }
    }
    
    // Se a mensagem não foi editada (ou a edição falhou), cria uma nova.
    if (!message) {
      message = await sendMessageWithBot(CONFIG.mainChannelId, null, body);
    }
    
    if (message) console.log(`Embed de estoque ${CONFIG.mainMessageId ? 'atualizado' : 'criado'}.`);
    
    return message; // Retorna a mensagem para que o ID possa ser salvo
  } catch (err) {
    console.error('Erro ao atualizar main embed:', err);
  }
}

// read selected message to populate stock (if you used a message to store stock)
async function fetchSelectedMessage() {
  if (!CONFIG.mainChannelId || !CONFIG.mainMessageId) {
    console.log('Canal/ID da mensagem não configurados para leitura.');
    return;
  }
  try {
    if (!bot.isReady()) {
      console.error('Bot não está pronto para buscar mensagens.');
      return;
    }
    const channel = await bot.channels.fetch(CONFIG.mainChannelId);
    if (!channel || !channel.isTextBased()) return;

    const message = await channel.messages.fetch(CONFIG.mainMessageId);
    if (message && message.embeds && message.embeds.length > 0) {
      console.log('Lendo embed do Discord para atualizar estoque local...');
      const fields = message.embeds[0].fields || [];
      
      const currentStock = await prisma.stockItem.findMany();
      const updatePromises = [];

      // Itera sobre os campos do embed para atualizar o estoque local
      fields.forEach(field => {
        // Encontra o item correspondente no estoque local pelo nome
        const itemInStock = currentStock.find(item => field.name.includes(item.name));
        
        if (itemInStock) {
          const cleaned = String(field.value).replace(/\*\*/g, '');
          const matchQty = cleaned.match(/Estoque:\s*([0-9]+|ESGOTADO)/i);
          const matchPrice = cleaned.match(/Preço:\s*R\$([\d,.]+)/i);

          const dataToUpdate = {};
          if (matchQty) {
            dataToUpdate.quantity = matchQty[1].toUpperCase() === 'ESGOTADO' ? 0 : parseInt(matchQty[1], 10);
          }
          if (matchPrice) {
            dataToUpdate.price = parseFloat(matchPrice[1].replace(',', '.'));
          }
          if (Object.keys(dataToUpdate).length > 0) {
            updatePromises.push(prisma.stockItem.update({ where: { id: itemInStock.id }, data: dataToUpdate }));
          }
        }
      });

      await Promise.all(updatePromises);
      console.log('Estoque local atualizado com base na mensagem do Discord. Itens novos foram preservados.');
    }
  } catch (err) {
    console.error('Erro ao buscar mensagem selecionada:', err);
  }
}

async function startServer() {
  // 1. Verifica as variáveis de ambiente
  if (!process.env.DATABASE_URL || !process.env.BOT_TOKEN) {
    console.error('Erro Crítico: As variáveis de ambiente DATABASE_URL e BOT_TOKEN devem ser definidas no arquivo .env.');
    process.exit(1); // Encerra a aplicação se o DB não estiver configurado.
  }

  // 2. Carrega as configurações do config.json
  await loadConfig();

  // 3. Conecta o bot do Discord
  console.log("Fazendo login do bot...");
  await bot.login(process.env.BOT_TOKEN);

  bot.on('ready', async () => {
    console.log(`Bot logado como ${bot.user.tag}!`);

    // 4. Popula o banco de dados se necessário
    await seedDatabase();

    // 5. Sincroniza com o Discord se configurado
    if (CONFIG.mainChannelId && CONFIG.mainMessageId) {
      await fetchSelectedMessage();
    }

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`🚀 Servidor rodando e pronto na porta ${PORT}`);
    });
  });

  bot.on('interactionCreate', async interaction => {
    try {
      // --- Manipulador do Botão "Comprar" ---
      if (interaction.isButton() && interaction.customId === 'buy_item_button') { // Botão Comprar
        await interaction.deferReply({ ephemeral: true });

        const availableStock = await prisma.stockItem.findMany({
          where: { quantity: { gt: 0 } },
          orderBy: { name: 'asc' }
        });

        if (availableStock.length === 0) {
          await interaction.editReply({ content: 'Desculpe, todos os nossos itens estão esgotados no momento.' });
          return;
        }

        const selectMenu = {
          type: 1, // Action Row
          components: [
            {
              type: 3, // String Select Menu
              custom_id: 'select_item_to_buy',
              placeholder: 'Selecione um item para comprar',
              options: availableStock.map(item => ({
                label: item.name,
                description: `Preço: R$${item.price.toFixed(2)} | Estoque: ${item.quantity}`,
                value: item.id,
                emoji: item.emoji || undefined
              }))
            }
          ]
        };

        await interaction.editReply({
          content: 'Por favor, selecione o item que você deseja comprar:',
          components: [selectMenu]
        });
      }

      // --- Manipulador da Seleção do Item ---
      else if (interaction.isStringSelectMenu() && interaction.customId === 'select_item_to_buy') { // Seleção de item
        await interaction.deferUpdate(); // Apenas confirma o recebimento sem responder

        const selectedItemId = interaction.values[0];
        const item = await prisma.stockItem.findUnique({ where: { id: selectedItemId } });
        const owner = (await bot.application.fetch()).owner;

        if (!item) {
          await interaction.followUp({ content: 'O item selecionado não foi encontrado.', ephemeral: true });
          return;
        }

        // Cria um tópico privado (ticket)
        const thread = await interaction.channel.threads.create({
          name: `Compra de ${item.name} - ${interaction.user.username}`,
          autoArchiveDuration: 1440, // 24 horas
          type: ChannelType.PrivateThread, // Tópico privado
          reason: `Ticket de compra para ${interaction.user.tag}`
        });

        // Adiciona o usuário e o dono do bot ao tópico
        await thread.members.add(interaction.user.id);
        if (owner) await thread.members.add(owner.id);

        await thread.send({
          content: `Olá <@${interaction.user.id}> e <@${owner.id}>! Este é o seu ticket para a compra de **${item.emoji} ${item.name}**.\nPor favor, discutam os detalhes da transação aqui.`,
          components: [
            {
              type: 1, // Action Row
              components: [
                {
                  type: 2, // Button
                  style: 4, // Danger (vermelho)
                  label: 'Fechar Ticket',
                  custom_id: 'close_ticket'
                }
              ]
            }
          ]
        });
        
        // Envia a mensagem de confirmação para o admin no ticket
        if (owner) {
          await thread.send({
            content: `<@${owner.id}>, o pedido já foi entregue?`,
            components: [{
              type: 1, // Action Row
              components: [{
                type: 2, // Button
                style: 3, // Success
                label: 'Confirmar Entrega',
                // Codificamos os dados necessários no custom_id
                custom_id: `confirm_delivery_${item.id}_${interaction.user.id}`
              }]
            }]
          });
        }

        await interaction.followUp({ content: `Seu ticket de compra foi criado com sucesso: <#${thread.id}>`, ephemeral: true });
      }

      // --- Manipulador do Botão "Confirmar Entrega" ---
      else if (interaction.isButton() && interaction.customId.startsWith('confirm_delivery_')) { // Botão Confirmar Entrega
        const owner = (await bot.application.fetch()).owner;
        // Garante que apenas o dono do bot pode clicar
        if (interaction.user.id !== owner.id) {
          return interaction.reply({ content: 'Apenas o administrador pode confirmar a entrega.', ephemeral: true });
        }

        // Adia a resposta para evitar o erro "Unknown Interaction"
        await interaction.deferReply({ ephemeral: true });

        const [, itemId, buyerId] = interaction.customId.split('_');
        const item = await prisma.stockItem.findUnique({ where: { id: itemId } });

        if (!item) {
          return interaction.editReply({ content: 'Erro: Item não encontrado.' });
        }

        // Desativa o botão para evitar cliques duplos
        // Corrigido: Obtém a mensagem original da interação e edita seus componentes.
        const originalMessage = interaction.message;
        const disabledComponents = originalMessage.components.map(row => ({ ...row, components: row.components.map(c => ({ ...c.data, disabled: true })) }));
        await originalMessage.edit({ components: disabledComponents });
        await interaction.editReply({ content: 'Botão desativado. Processando...' }); // Confirma que a ação foi recebida.

        // Pede a foto e a nota
        await interaction.followUp({ content: 'Por favor, envie a foto de comprovação e/ou uma nota para a entrega (ex: "entregue em mãos"). Você tem 2 minutos.', ephemeral: true });

        const filter = m => m.author.id === owner.id;
        const collector = interaction.channel.createMessageCollector({ filter, time: 120000, max: 1 });

        collector.on('collect', async msg => {
          const photoUrl = msg.attachments.first()?.url;
          const note = msg.content;

          // Usa a função de entrega existente, passando os dados coletados
          await createDelivery(buyerId, itemId, 1, note, photoUrl, interaction.channelId);
          await msg.reply('✅ Entrega registrada com sucesso no canal de entregas!');
          
          // Fecha o ticket após a confirmação
          await interaction.channel.send('Este ticket será fechado em 10 segundos.');
          setTimeout(() => {
            interaction.channel.setArchived(true, 'Entrega confirmada e ticket finalizado.');
          }, 10000);
        });

        collector.on('end', async (collected, reason) => {
          if (reason === 'time') {
            // Se o tempo esgotar, ainda registra a entrega sem foto/nota
            await createDelivery(buyerId, itemId, 1, 'Entrega confirmada pelo painel do ticket.', null, interaction.channelId);
            await interaction.followUp({ content: '⏳ Tempo esgotado. A entrega foi registrada sem foto ou nota.', ephemeral: true });
            
            // Fecha o ticket
            await interaction.channel.send('Este ticket será fechado em 10 segundos.');
            setTimeout(() => {
              interaction.channel.setArchived(true, 'Entrega confirmada e ticket finalizado.');
            }, 10000);
          }
        });
      }

      // --- Manipulador do Botão "Fechar Ticket" ---
      else if (interaction.isButton() && interaction.customId === 'close_ticket') {
        await interaction.reply({ content: 'O ticket será fechado em 5 segundos...' });
        
        // Desativa o botão para evitar cliques múltiplos
        const message = interaction.message;
        const newComponents = message.components.map(row => ({ ...row, components: row.components.map(c => ({ ...c.data, disabled: true })) }));
        await message.edit({ components: newComponents });

        setTimeout(() => interaction.channel.setArchived(true, 'Ticket fechado manualmente.'), 5000);
      }
    } catch (error) {
      console.error('Erro ao processar interação:', error);
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: 'Ocorreu um erro ao processar sua solicitação.', ephemeral: true });
      } else {
        await interaction.reply({ content: 'Ocorreu um erro ao processar sua solicitação.', ephemeral: true });
      }
    }
  });

  // Função refatorada para criar uma entrega, pode ser chamada de qualquer lugar
  async function createDelivery(mention, itemId, quantity, note, photoUrl, channelIdForFeedback) {
    try {
      if (!CONFIG.deliveryChannelId) {
        if (channelIdForFeedback) await bot.channels.cache.get(channelIdForFeedback)?.send('Erro: Canal de entregas não configurado.');
        return;
      }
      const item = await prisma.stockItem.findUnique({ where: { id: itemId } });
      if (!item) {
        if (channelIdForFeedback) await bot.channels.cache.get(channelIdForFeedback)?.send('Erro: Item da entrega não encontrado.');
        return;
      }

      const embed = {
        title: '📦 Entrega Confirmada',
        color: 3066993,
        thumbnail: photoUrl ? { url: photoUrl } : undefined,
        fields: [
          { name: 'Destinatário', value: CONFIG.clientRoleId ? `<@&${CONFIG.clientRoleId}>` : 'Não configurado', inline: true },
          { name: 'Produto', value: `${item.emoji} ${item.name}`, inline: true },
          { name: 'Quantidade', value: String(quantity), inline: true },
        ],
        description: note ? `${note}` : undefined,
        footer: { text: 'DOLLYA STORE — Entrega' }
      };
      
      // A menção no conteúdo será do cargo, se configurado.
      const content = CONFIG.clientRoleId ? `<@&${CONFIG.clientRoleId}>` : 'Nova entrega registrada!';
      
      const body = {
        content: content,
        embeds: [embed]
      };

      const sentMessage = await sendMessageWithBot(CONFIG.deliveryChannelId, null, body);

      await prisma.deliveryRecord.create({
        data: {
          mention: mention,
          itemId,
          itemName: item.name,
          quantity: quantity,
          photoUrl,
          messageSent: !!sentMessage,
          messageStatus: sentMessage ? 200 : 500
        }
      });

      // Atualiza o estoque
      await prisma.stockItem.update({
        where: { id: itemId },
        data: { quantity: { decrement: quantity } }
      });
    } catch (error) {
      console.error('Erro ao criar entrega via bot:', error);
    }
  }

  bot.on('error', console.error);
}

startServer().catch(err => {
  console.error("Falha ao iniciar o servidor:", err);
  process.exit(1);
});
