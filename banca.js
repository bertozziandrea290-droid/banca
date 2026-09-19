const { 
    Client, 
    GatewayIntentBits, 
    EmbedBuilder, 
    SlashCommandBuilder, 
    PermissionFlagsBits, 
    REST, 
    Routes,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');
const { Pool } = require('pg');
const express = require('express');

// --- ID CONFIGURAZIONE RUOLI E CANALI ---
const RUOLO_CONTO_ID = '1545529767720124447';          // Ruolo titolare di conto corrente
const RUOLO_DISOCCUPAZIONE_ID = '1545773712597586030'; // Ruolo Disoccupazione base (100 €)
const RUOLO_STIPENDIO_500_ID = '1545773854859730975';  // Ruolo Stipendio maggiorato (500 €)
const RUOLO_STAFF_ID = '1545516649388703754';           // Ruolo Staff generale per approvazione moduli
const RUOLO_ADMIN_ID = '1488506245848764466';           // Ruolo Amministrazione per comandi gestionali avanzati
const CANALE_STAFF_ID = '1475938917818564688';          // Canale dove inviare le richieste di apertura conto

// --- 1. KEEP-ALIVE SERVER PER RENDER ---
const app = express();
const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => {
    res.send('🏦 Server Banca Bot RP è Online!');
});

app.listen(PORT, () => {
    console.log(`📡 Mini server web in ascolto sulla porta ${PORT}`);
});

// --- 2. DATABASE POSTGRESQL PERSISTENTE ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function initDb() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS conti (
                user_id VARCHAR(30) PRIMARY KEY,
                saldo BIGINT DEFAULT 0,
                contanti BIGINT DEFAULT 500,
                ha_conto INT DEFAULT 0,
                ultimo_stipendio BIGINT DEFAULT 0
            )
        `);
        console.log('✅ Database PostgreSQL connesso e inizializzato!');
    } catch (err) {
        console.error('❌ Errore connessione DB:', err);
    }
}
initDb();

async function getUtente(userId) {
    const res = await pool.query('SELECT * FROM conti WHERE user_id = $1', [userId]);
    if (res.rows.length === 0) {
        await pool.query('INSERT INTO conti (user_id, saldo, contanti, ha_conto, ultimo_stipendio) VALUES ($1, 0, 500, 0, 0)', [userId]);
        return { user_id: userId, saldo: 0, contanti: 500, ha_conto: 0, ultimo_stipendio: 0 };
    }
    return {
        user_id: res.rows[0].user_id,
        saldo: parseInt(res.rows[0].saldo),
        contanti: parseInt(res.rows[0].contanti),
        ha_conto: parseInt(res.rows[0].ha_conto),
        ultimo_stipendio: parseInt(res.rows[0].ultimo_stipendio)
    };
}

async function apriContoDb(userId) {
    await getUtente(userId);
    await pool.query('UPDATE conti SET ha_conto = 1, saldo = 1000 WHERE user_id = $1', [userId]);
}

async function chiudiContoDb(userId) {
    await pool.query('UPDATE conti SET ha_conto = 0, saldo = 0 WHERE user_id = $1', [userId]);
}

async function impostaSaldoFisso(userId, nuovoSaldo) {
    await getUtente(userId);
    await pool.query('UPDATE conti SET saldo = $1 WHERE user_id = $2', [nuovoSaldo, userId]);
}

async function impostaContantiFissi(userId, nuoviContanti) {
    await getUtente(userId);
    await pool.query('UPDATE conti SET contanti = $1 WHERE user_id = $2', [nuoviContanti, userId]);
}

async function modificaSaldo(userId, importo) {
    const user = await getUtente(userId);
    const nuovoSaldo = user.saldo + importo;
    await pool.query('UPDATE conti SET saldo = $1 WHERE user_id = $2', [nuovoSaldo, userId]);
    return nuovoSaldo;
}

async function modificaContanti(userId, importo) {
    const user = await getUtente(userId);
    const nuoviContanti = user.contanti + importo;
    await pool.query('UPDATE conti SET contanti = $1 WHERE user_id = $2', [nuoviContanti, userId]);
    return nuoviContanti;
}

async function aggiornaStipendio(userId, timestamp) {
    await pool.query('UPDATE conti SET ultimo_stipendio = $1 WHERE user_id = $2', [timestamp, userId]);
}

// --- FUNZIONI AUSILIARIE GIOCHI ---
function generaCarta() {
    const carte = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    return carte[Math.floor(Math.random() * carte.length)];
}

function calcolaPuntiBlackjack(carte) {
    let punti = 0;
    let assi = 0;
    for (const carta of carte) {
        if (carta === 'A') {
            assi += 1;
            punti += 11;
        } else if (['J', 'Q', 'K'].includes(carta)) {
            punti += 10;
        } else {
            punti += parseInt(carta);
        }
    }
    while (punti > 21 && assi > 0) {
        punti -= 10;
        assi -= 1;
    }
    return punti;
}

// --- 3. INIZIALIZZAZIONE BOT DISCORD ---
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ] 
});

const commands = [
    new SlashCommandBuilder()
        .setName('conto')
        .setDescription('Visualizza il saldo del tuo conto o di un altro cittadino.')
        .addUserOption(opt => opt.setName('utente').setDescription('Utente di cui verificare il conto')),

    new SlashCommandBuilder()
        .setName('stipendio')
        .setDescription('Riscatta lo stipendio giornaliero.'),

    new SlashCommandBuilder()
        .setName('bonifico')
        .setDescription('Invia denaro a un altro cittadino.')
        .addUserOption(opt => opt.setName('destinatario').setDescription('Destinatario').setRequired(true))
        .addIntegerOption(opt => opt.setName('importo').setDescription('Importo').setRequired(true)),

    new SlashCommandBuilder()
        .setName('deposito')
        .setDescription('Deposita i contanti sul tuo conto corrente.')
        .addIntegerOption(opt => opt.setName('importo').setDescription('Importo da depositare').setRequired(true)),

    new SlashCommandBuilder()
        .setName('prelievo')
        .setDescription('Preleva denaro dal tuo conto corrente.')
        .addIntegerOption(opt => opt.setName('importo').setDescription('Importo da prelevare').setRequired(true)),

    new SlashCommandBuilder()
        .setName('classifica')
        .setDescription('Mostra i 5 cittadini più ricchi del server.'),

    new SlashCommandBuilder()
        .setName('casino')
        .setDescription('Scommetti i tuoi fondi bancari ai giochi del Casinò.')
        .addStringOption(opt => 
            opt.setName('gioco')
               .setDescription('Seleziona il gioco del casinò')
               .setRequired(true)
               .addChoices(
                   { name: '🎰 Slot Machine', value: 'slot' },
                   { name: '🃏 Blackjack', value: 'blackjack' },
                   { name: '🎯 Roulette', value: 'roulette' }
               )
        )
        .addIntegerOption(opt => opt.setName('importo').setDescription('Cifra da scommettere').setRequired(true))
        .addStringOption(opt => 
            opt.setName('scommessa_roulette')
               .setDescription('[Solo per Roulette] Scegli su cosa puntare')
               .addChoices(
                   { name: '🔴 Rosso (2x)', value: 'rosso' },
                   { name: '⚫ Nero (2x)', value: 'nero' },
                   { name: '2️⃣ Pari (2x)', value: 'pari' },
                   { name: '1️⃣ Dispari (2x)', value: 'dispari' },
                   { name: '🟢 Zero (36x)', value: 'zero' }
               )
        )
        .addIntegerOption(opt => opt.setName('numero_roulette').setDescription('[Solo per Roulette] Numero preciso da 1 a 36 (36x)')),

    // --- COMANDI AMMINISTRAZIONE ---
    new SlashCommandBuilder()
        .setName('paga')
        .setDescription('[AMMINISTRAZIONE] Aggiunge fondi al conto bancario di un utente.')
        .addUserOption(opt => opt.setName('utente').setDescription('Utente').setRequired(true))
        .addIntegerOption(opt => opt.setName('importo').setDescription('Importo').setRequired(true)),

    new SlashCommandBuilder()
        .setName('multa')
        .setDescription('[AMMINISTRAZIONE] Detrae fondi dal conto bancario di un utente.')
        .addUserOption(opt => opt.setName('utente').setDescription('Utente').setRequired(true))
        .addIntegerOption(opt => opt.setName('importo').setDescription('Importo').setRequired(true)),

    new SlashCommandBuilder()
        .setName('set-saldo')
        .setDescription('[AMMINISTRAZIONE] Imposta il saldo bancario esatto di un utente.')
        .addUserOption(opt => opt.setName('utente').setDescription('Utente').setRequired(true))
        .addIntegerOption(opt => opt.setName('importo').setDescription('Nuovo saldo').setRequired(true)),

    new SlashCommandBuilder()
        .setName('set-contanti')
        .setDescription('[AMMINISTRAZIONE] Imposta la quantità esatta di contanti di un utente.')
        .addUserOption(opt => opt.setName('utente').setDescription('Utente').setRequired(true))
        .addIntegerOption(opt => opt.setName('importo').setDescription('Nuovi contanti').setRequired(true)),

    new SlashCommandBuilder()
        .setName('reset-conto')
        .setDescription('[AMMINISTRAZIONE] Azzera completamente conto corrente e contanti di un utente.')
        .addUserOption(opt => opt.setName('utente').setDescription('Utente da resettare').setRequired(true))
];

client.once('ready', async () => {
    console.log(`✅ Bot autenticato come ${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        console.log('🔄 Registrazione comandi slash...');
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('✅ Comandi slash registrati!');
    } catch (error) {
        console.error('❌ Errore comandi:', error);
    }
});

// AUTOROLE DISOCCUPAZIONE
client.on('guildMemberAdd', async member => {
    try {
        const role = member.guild.roles.cache.get(RUOLO_DISOCCUPAZIONE_ID);
        if (role) await member.roles.add(role);
    } catch (err) {
        console.error(`❌ Errore AutoRole:`, err);
    }
});

// PANNELLO BANCA (!banca)
client.on('messageCreate', async message => {
    if (message.author.bot) return;

    if (message.content.toLowerCase() === '!banca') {
        const embed = new EmbedBuilder()
            .setTitle('🏛️ BANCA CENTRALE ROLEPLAY')
            .setDescription(
                '```ansi\n\u001b[1;32m════════════════════════════════════════\u001b[0m\n' +
                '\u001b[1;37m        SPORTELLO BANCARIO DIGITALE        \u001b[0m\n' +
                '\u001b[1;32m════════════════════════════════════════\u001b[0m\n```\n' +
                'Benvenuto nella piattaforma bancaria ufficiale del server.\n' +
                'Da qui puoi richiedere l\'apertura di un **Conto Corrente**, verificare il tuo saldo o gestire i tuoi fondi.'
            )
            .setColor(0x2ECC71)
            .addFields(
                { 
                    name: '📜 **VANTAGGI CONTO CORRENTE**', 
                    value: '• **Bonus di Benvenuto:** `1.000 €` diretti sul conto\n' +
                           '• **Assegnazione Ruolo:** <@&' + RUOLO_CONTO_ID + '>\n' +
                           '• **Funzionalità:** Accredito stipendi, bonifici, prelievi e casinò', 
                    inline: false 
                },
                { 
                    name: '📲 **COMANDI DISPONIBILI**', 
                    value: '` /conto ` • Consulta il tuo estratto conto\n' +
                           '` /stipendio ` • Riscatta lo stipendio giornaliero\n' +
                           '` /bonifico ` • Trasferisci fondi ad un altro cittadino\n' +
                           '` /deposito ` & ` /prelievo ` • Gestisci i tuoi contanti\n' +
                           '` /casino ` • Gioca a Slot, Blackjack e Roulette', 
                    inline: false 
                }
            )
            .setThumbnail(message.guild.iconURL({ dynamic: true }) || null)
            .setFooter({ text: 'Banca Centrale Roleplay • Operativo 24/7', iconURL: client.user.displayAvatarURL() })
            .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('apri_conto').setLabel('Richiedi Conto').setEmoji('💳').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('saldo_rapido').setLabel('Estratto Conto').setEmoji('🔍').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('chiudi_conto').setLabel('Chiudi Conto').setEmoji('🚫').setStyle(ButtonStyle.Danger)
        );

        await message.channel.send({ embeds: [embed], components: [row] });
    }
});

// GESTIONE INTERAZIONI (PULSANTI E SLASH COMMANDS)
client.on('interactionCreate', async interaction => {
    // --- 1. PULSANTI ---
    if (interaction.isButton()) {
        const { customId, user, guild, member } = interaction;

        // APRI CONTO
        if (customId === 'apri_conto') {
            await interaction.deferReply({ ephemeral: true });
            try {
                const userData = await getUtente(user.id);

                if (userData.ha_conto === 1) {
                    return interaction.editReply({ content: '⚠️ Risulta già attivo un conto corrente intestato a questo profilo.' });
                }

                const staffChannel = guild.channels.cache.get(CANALE_STAFF_ID);
                if (!staffChannel) {
                    return interaction.editReply({ content: '❌ Errore: Canale Staff non trovato o ID configurato errato.' });
                }

                const embedStaff = new EmbedBuilder()
                    .setTitle('📋 NUOVA PRATICA APERTURA CONTO')
                    .setDescription('Un cittadino ha inoltrato una richiesta formale di apertura conto corrente.')
                    .setColor(0xE67E22)
                    .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
                    .addFields(
                        { name: '👤 Richiedente', value: `${user}\n\`${user.tag}\``, inline: true },
                        { name: '🆔 ID Utente', value: `\`${user.id}\``, inline: true },
                        { name: '💵 Contanti Attuali', value: `\`${userData.contanti.toLocaleString('it-IT')} €\``, inline: true },
                        { name: '🎁 Bonus Benvenuto', value: '`1.000 €`', inline: true },
                        { name: '📌 Stato Pratica', value: '⏳ **In attesa di revisione**', inline: true }
                    )
                    .setFooter({ text: 'Sistema di Gestione Pratiche • Banca RP', iconURL: guild.iconURL() })
                    .setTimestamp();

                const rowStaff = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`approva_${user.id}`).setLabel('Approva Conto').setEmoji('✅').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`rifiuta_${user.id}`).setLabel('Rifiuta Conto').setEmoji('❌').setStyle(ButtonStyle.Danger)
                );

                await staffChannel.send({ embeds: [embedStaff], components: [rowStaff] });

                const embedConferma = new EmbedBuilder()
                    .setTitle('📨 Richiesta Inviata!')
                    .setDescription('La tua richiesta di apertura conto è stata presa in carico dallo Staff.\nRiceverai una notifica non appena verrà revisionata.')
                    .setColor(0x3498DB);

                return interaction.editReply({ embeds: [embedConferma] });
            } catch (err) {
                console.error('Errore apri_conto:', err);
                return interaction.editReply({ content: '❌ Errore durante l\'elaborazione della richiesta.' });
            }
        }

        // APPROVAZIONE O RIFIUTO DA PARTE DELLO STAFF
        if (customId.startsWith('approva_') || customId.startsWith('rifiuta_')) {
            await interaction.deferUpdate();

            if (!member.roles.cache.has(RUOLO_STAFF_ID) && !member.roles.cache.has(RUOLO_ADMIN_ID)) {
                return interaction.followUp({ content: '🚫 Non sei autorizzato a gestire questa pratica.', ephemeral: true });
            }

            const action = customId.split('_')[0];
            const targetUserId = customId.split('_')[1];
            const targetMember = await guild.members.fetch(targetUserId).catch(() => null);

            if (action === 'approva') {
                await apriContoDb(targetUserId);

                if (targetMember) {
                    const role = guild.roles.cache.get(RUOLO_CONTO_ID);
                    if (role) await targetMember.roles.add(role).catch(() => {});

                    const embedDM = new EmbedBuilder()
                        .setTitle('🎉 CONTO CORRENTE APPROVATO!')
                        .setDescription(`Complimenti! La tua richiesta per l'apertura del conto corrente presso la **Banca Centrale** è stata **Approvata**.\n\n` +
                                        `• **Bonus Accreditato:** \`1.000 €\`\n` +
                                        `• **Ruolo Assegnato:** <@&${RUOLO_CONTO_ID}>`)
                        .setColor(0x2ECC71)
                        .setTimestamp();

                    await targetMember.send({ embeds: [embedDM] }).catch(() => {});
                }

                const embedApproved = new EmbedBuilder()
                    .setTitle('✅ PRATICA APPROVATA')
                    .setDescription(`La pratica di apertura conto per <@${targetUserId}> è stata **approvata**.`)
                    .setColor(0x2ECC71)
                    .addFields(
                        { name: '👤 Richiedente', value: `<@${targetUserId}> (\`${targetUserId}\`)`, inline: true },
                        { name: '👮 Gestito da', value: `${user}`, inline: true },
                        { name: '💰 Bonus Erogato', value: '`1.000 €`', inline: true }
                    )
                    .setFooter({ text: 'Pratica Chiusa • Banca RP' })
                    .setTimestamp();

                await interaction.editReply({ embeds: [embedApproved], components: [] });

            } else {
                const embedRejected = new EmbedBuilder()
                    .setTitle('❌ PRATICA RIFIUTATA')
                    .setDescription(`La pratica di apertura conto per <@${targetUserId}> è stata **respinta**.`)
                    .setColor(0xE74C3C)
                    .addFields(
                        { name: '👤 Richiedente', value: `<@${targetUserId}> (\`${targetUserId}\`)`, inline: true },
                        { name: '👮 Gestito da', value: `${user}`, inline: true }
                    )
                    .setFooter({ text: 'Pratica Chiusa • Banca RP' })
                    .setTimestamp();

                if (targetMember) {
                    const embedDM = new EmbedBuilder()
                        .setTitle('🚫 Richiesta Conto Respinta')
                        .setDescription('La tua richiesta di apertura conto corrente è stata rifiutata dallo Staff.')
                        .setColor(0xE74C3C)
                        .setTimestamp();

                    await targetMember.send({ embeds: [embedDM] }).catch(() => {});
                }

                await interaction.editReply({ embeds: [embedRejected], components: [] });
            }
            return;
        }

        // SALDO RAPIDO
        if (customId === 'saldo_rapido') {
            await interaction.deferReply({ ephemeral: true });
            const userData = await getUtente(user.id);

            if (userData.ha_conto === 0) return interaction.editReply({ content: '❌ Nessun conto attivo trovato.' });

            const embedSaldo = new EmbedBuilder()
                .setTitle('💳 SALDO CONTO CORRENTE')
                .setColor(0x3498DB)
                .addFields(
                    { name: '🏦 Deposito Bancario', value: `\`${userData.saldo.toLocaleString('it-IT')} €\``, inline: true },
                    { name: '💵 Contanti in Tasca', value: `\`${userData.contanti.toLocaleString('it-IT')} €\``, inline: true }
                )
                .setTimestamp();

            return interaction.editReply({ embeds: [embedSaldo] });
        }

        // CHIUDI CONTO
        if (customId === 'chiudi_conto') {
            await interaction.deferReply({ ephemeral: true });
            const userData = await getUtente(user.id);

            if (userData.ha_conto === 0) return interaction.editReply({ content: '⚠️ Non possiedi un conto da chiudere.' });
            await chiudiContoDb(user.id);
            const roleConto = guild.roles.cache.get(RUOLO_CONTO_ID);
            if (roleConto) await member.roles.remove(roleConto).catch(() => {});

            const embedChiusura = new EmbedBuilder()
                .setTitle('🗑️ Conto Chiuso')
                .setDescription('Il tuo conto corrente è stato estinto con successo e il saldo è stato azzerato.')
                .setColor(0xE74C3C);

            return interaction.editReply({ embeds: [embedChiusura] });
        }
    }

    // --- 2. COMANDI SLASH ---
    if (!interaction.isChatInputCommand()) return;
    const { commandName, options, user, member } = interaction;
    const userData = await getUtente(user.id);

    // CONTROLLO PERMESSI AMMINISTRAZIONE
    const comandiAdmin = ['paga', 'multa', 'set-saldo', 'set-contanti', 'reset-conto'];
    if (comandiAdmin.includes(commandName)) {
        if (!member.roles.cache.has(RUOLO_ADMIN_ID)) {
            return interaction.reply({ 
                content: `🚫 **Accesso Negato!** Solamente i membri con il ruolo Amministrazione (<@&${RUOLO_ADMIN_ID}>) possono utilizzare questo comando.`, 
                ephemeral: true 
            });
        }
    }

    // COMANDO STIPENDIO
    if (commandName === 'stipendio') {
        const haDisoccupazione = member.roles.cache.has(RUOLO_DISOCCUPAZIONE_ID);
        const haStipendio500 = member.roles.cache.has(RUOLO_STIPENDIO_500_ID);

        if (!haDisoccupazione && !haStipendio500) {
            return interaction.reply({ content: `❌ Non possiedi un ruolo idoneo per riscuotere uno stipendio.`, ephemeral: true });
        }
        if (userData.ha_conto === 0) return interaction.reply({ content: '❌ Devi prima aprire un conto corrente bancario per ricevere l\'accredito.', ephemeral: true });

        const ORA = Date.now();
        const COOLDOWN = 24 * 60 * 60 * 1000;
        if (ORA - userData.ultimo_stipendio < COOLDOWN) {
            const ore = Math.ceil((COOLDOWN - (ORA - userData.ultimo_stipendio)) / (1000 * 60 * 60));
            return interaction.reply({ content: `⏳ Hai già riscosso lo stipendio! Riprova tra **${ore} ore**.`, ephemeral: true });
        }

        let importoStipendio = haStipendio500 ? 500 : 100;
        const nuovoSaldo = await modificaSaldo(user.id, importoStipendio);
        await aggiornaStipendio(user.id, ORA);

        const embedStipendio = new EmbedBuilder()
            .setTitle('💵 ACCREDITO STIPENDIO GIORNALIERO')
            .setDescription('Lo stipendio è stato depositato direttamente sul tuo conto corrente bancario.')
            .setColor(0x2ECC71)
            .addFields(
                { name: '💰 Importo Accreditato', value: `\`+${importoStipendio.toLocaleString('it-IT')} €\``, inline: true },
                { name: '🏦 Nuovo Saldo Bancario', value: `\`${nuovoSaldo.toLocaleString('it-IT')} €\``, inline: true }
            )
            .setFooter({ text: 'Banca Centrale Roleplay • Accrediti' })
            .setTimestamp();

        return interaction.reply({ embeds: [embedStipendio], ephemeral: true });
    }

    // COMANDO BONIFICO
    if (commandName === 'bonifico') {
        const destinatario = options.getUser('destinatario');
        const importo = options.getInteger('importo');
        const destData = await getUtente(destinatario.id);

        if (userData.ha_conto === 0) return interaction.reply({ content: '❌ Devi possedere un conto corrente per inviare un bonifico.', ephemeral: true });
        if (destData.ha_conto === 0) return interaction.reply({ content: '❌ Il destinatario non possiede un conto corrente attivo.', ephemeral: true });
        if (importo <= 0 || userData.saldo < importo) return interaction.reply({ content: '❌ Importo non valido o saldo bancario insufficiente.', ephemeral: true });
        if (destinatario.id === user.id) return interaction.reply({ content: '❌ Non puoi inviare un bonifico a te stesso.', ephemeral: true });

        const nuovoSaldoMittente = await modificaSaldo(user.id, -importo);
        const nuovoSaldoDestinatario = await modificaSaldo(destinatario.id, importo);

        const embedMittente = new EmbedBuilder()
            .setTitle('💸 BONIFICO ESEGUITO CON SUCCESSO')
            .setColor(0x3498DB)
            .addFields(
                { name: '👤 Destinatario', value: `<@${destinatario.id}>`, inline: true },
                { name: '📤 Importo Inviato', value: `\`${importo.toLocaleString('it-IT')} €\``, inline: true },
                { name: '🏦 Saldo Rimanente', value: `\`${nuovoSaldoMittente.toLocaleString('it-IT')} €\``, inline: true }
            )
            .setFooter({ text: 'Banca Centrale Roleplay • Trasferimenti' })
            .setTimestamp();

        const targetMember = await interaction.guild.members.fetch(destinatario.id).catch(() => null);
        if (targetMember) {
            const embedDM = new EmbedBuilder()
                .setTitle('📩 ACCREDITO BONIFICO RICEVUTO')
                .setDescription(`Hai ricevuto un trasferimento fondi da **${user.tag}**.`)
                .setColor(0x2ECC71)
                .addFields(
                    { name: '📥 Importo Ricevuto', value: `\`+${importo.toLocaleString('it-IT')} €\``, inline: true },
                    { name: '🏦 Nuovo Saldo', value: `\`${nuovoSaldoDestinatario.toLocaleString('it-IT')} €\``, inline: true }
                )
                .setFooter({ text: 'Banca Centrale Roleplay' })
                .setTimestamp();

            await targetMember.send({ embeds: [embedDM] }).catch(() => {});
        }

        return interaction.reply({ embeds: [embedMittente], ephemeral: true });
    }

    // COMANDO DEPOSITO
    if (commandName === 'deposito') {
        const importo = options.getInteger('importo');
        if (userData.ha_conto === 0 || importo <= 0 || userData.contanti < importo) {
            return interaction.reply({ content: '❌ Operazione non valida o contanti in tasca insufficienti.', ephemeral: true });
        }

        const nuoviContanti = await modificaContanti(user.id, -importo);
        const nuovoSaldo = await modificaSaldo(user.id, importo);

        const embedDeposito = new EmbedBuilder()
            .setTitle('📥 DEPOSITO IN BANCA ESEGUITO')
            .setColor(0x2ECC71)
            .addFields(
                { name: '💵 Contanti Deposita', value: `\`${importo.toLocaleString('it-IT')} €\``, inline: true },
                { name: '🏦 Nuovo Saldo Bancario', value: `\`${nuovoSaldo.toLocaleString('it-IT')} €\``, inline: true },
                { name: '💼 Contanti Residui', value: `\`${nuoviContanti.toLocaleString('it-IT')} €\``, inline: true }
            )
            .setFooter({ text: 'Banca Centrale Roleplay' })
            .setTimestamp();

        return interaction.reply({ embeds: [embedDeposito], ephemeral: true });
    }

    // COMANDO PRELIEVO
    if (commandName === 'prelievo') {
        const importo = options.getInteger('importo');
        if (userData.ha_conto === 0 || importo <= 0 || userData.saldo < importo) {
            return interaction.reply({ content: '❌ Operazione non valida o saldo bancario insufficiente.', ephemeral: true });
        }

        const nuovoSaldo = await modificaSaldo(user.id, -importo);
        const nuoviContanti = await modificaContanti(user.id, importo);

        const embedPrelievo = new EmbedBuilder()
            .setTitle('ATM PRELIEVO CONTANTI ESEGUITO')
            .setColor(0xE67E22)
            .addFields(
                { name: '💵 Contanti Prelevati', value: `\`${importo.toLocaleString('it-IT')} €\``, inline: true },
                { name: '🏦 Saldo Bancario Rimanente', value: `\`${nuovoSaldo.toLocaleString('it-IT')} €\``, inline: true },
                { name: '💼 Totale Contanti in Tasca', value: `\`${nuoviContanti.toLocaleString('it-IT')} €\``, inline: true }
            )
            .setFooter({ text: 'Banca Centrale Roleplay' })
            .setTimestamp();

        return interaction.reply({ embeds: [embedPrelievo], ephemeral: true });
    }

    // COMANDI AMMINISTRAZIONE
    if (commandName === 'paga') {
        const target = options.getUser('utente');
        const importo = options.getInteger('importo');
        if (importo <= 0) return interaction.reply({ content: '❌ Inserisci un importo valido.', ephemeral: true });

        const s = await modificaSaldo(target.id, importo);
        const embed = new EmbedBuilder()
            .setTitle('💳 ACCREDITO AMMINISTRATIVO')
            .setColor(0x2ECC71)
            .addFields(
                { name: '👤 Utente Beneficiario', value: `<@${target.id}>`, inline: true },
                { name: '➕ Importo Accreditato', value: `\`+${importo.toLocaleString('it-IT')} €\``, inline: true },
                { name: '🏦 Nuovo Saldo', value: `\`${s.toLocaleString('it-IT')} €\``, inline: true }
            )
            .setFooter({ text: 'Registro Operazioni Riservate' })
            .setTimestamp();

        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (commandName === 'multa') {
        const target = options.getUser('utente');
        const importo = options.getInteger('importo');
        if (importo <= 0) return interaction.reply({ content: '❌ Inserisci un importo valido.', ephemeral: true });

        const s = await modificaSaldo(target.id, -importo);
        const embed = new EmbedBuilder()
            .setTitle('⚠️ DETRAZIONE AMMINISTRATIVA')
            .setColor(0xE74C3C)
            .addFields(
                { name: '👤 Utente Interessato', value: `<@${target.id}>`, inline: true },
                { name: '➖ Importo Detratto', value: `\`-${importo.toLocaleString('it-IT')} €\``, inline: true },
                { name: '🏦 Nuovo Saldo', value: `\`${s.toLocaleString('it-IT')} €\``, inline: true }
            )
            .setFooter({ text: 'Registro Operazioni Riservate' })
            .setTimestamp();

        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (commandName === 'set-saldo') {
        const target = options.getUser('utente');
        const importo = options.getInteger('importo');
        if (importo < 0) return interaction.reply({ content: '❌ L\'importo non può essere negativo.', ephemeral: true });

        await impostaSaldoFisso(target.id, importo);

        const embedSet = new EmbedBuilder()
            .setTitle('⚙️ REGOLAZIONE SALDO BANCARIO')
            .setColor(0x3498DB)
            .addFields(
                { name: '👤 Utente', value: `<@${target.id}>`, inline: true },
                { name: '💳 Nuovo Saldo Impostato', value: `\`${importo.toLocaleString('it-IT')} €\``, inline: true },
                { name: '👮 Eseguito da', value: `${user}`, inline: true }
            )
            .setFooter({ text: 'Registro Operazioni Riservate' })
            .setTimestamp();

        return interaction.reply({ embeds: [embedSet], ephemeral: true });
    }

    if (commandName === 'set-contanti') {
        const target = options.getUser('utente');
        const importo = options.getInteger('importo');
        if (importo < 0) return interaction.reply({ content: '❌ L\'importo non può essere negativo.', ephemeral: true });

        await impostaContantiFissi(target.id, importo);

        const embedSet = new EmbedBuilder()
            .setTitle('⚙️ REGOLAZIONE CONTANTI IN TASCA')
            .setColor(0x3498DB)
            .addFields(
                { name: '👤 Utente', value: `<@${target.id}>`, inline: true },
                { name: '💵 Nuovi Contanti Impostati', value: `\`${importo.toLocaleString('it-IT')} €\``, inline: true },
                { name: '👮 Eseguito da', value: `${user}`, inline: true }
            )
            .setFooter({ text: 'Registro Operazioni Riservate' })
            .setTimestamp();

        return interaction.reply({ embeds: [embedSet], ephemeral: true });
    }

    if (commandName === 'reset-conto') {
        const target = options.getUser('utente');
        await chiudiContoDb(target.id);
        await impostaContantiFissi(target.id, 0);

        const embedReset = new EmbedBuilder()
            .setTitle('💥 RESET ECONOMIA UTENTE')
            .setDescription(`Conto corrente e contanti di <@${target.id}> completamente azzerati.`)
            .setColor(0x95A5A6)
            .setFooter({ text: 'Registro Operazioni Riservate' })
            .setTimestamp();

        return interaction.reply({ embeds: [embedReset], ephemeral: true });
    }

    if (commandName === 'conto') {
        const target = options.getUser('utente') || user;
        const targetData = await getUtente(target.id);
        if (targetData.ha_conto === 0) return interaction.reply({ content: '❌ Nessun conto attivo trovato per questo cittadino.', ephemeral: true });

        const embed = new EmbedBuilder()
            .setTitle('🏛️ ESTRATTO CONTO UFFICIALE')
            .setColor(0xF1C40F)
            .setThumbnail(target.displayAvatarURL({ dynamic: true }))
            .addFields(
                { name: '👤 Intestatario', value: `<@${target.id}>`, inline: false },
                { name: '🏦 Deposito Bancario', value: `**${targetData.saldo.toLocaleString('it-IT')} €**`, inline: true },
                { name: '💵 Contanti in Tasca', value: `**${targetData.contanti.toLocaleString('it-IT')} €**`, inline: true }
            )
            .setFooter({ text: 'Banca Centrale Roleplay' })
            .setTimestamp();

        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (commandName === 'casino') {
        const gioco = options.getString('gioco');
        const importo = options.getInteger('importo');

        if (userData.ha_conto === 0 || importo <= 0 || userData.saldo < importo) {
            return interaction.reply({ content: '❌ Saldo insufficiente o conto assente.', ephemeral: true });
        }

        if (gioco === 'slot') {
            const simboli = ['🍋', '🍒', '🔔', '💎', '7️⃣'];
            const s1 = simboli[Math.floor(Math.random() * simboli.length)];
            const s2 = simboli[Math.floor(Math.random() * simboli.length)];
            const s3 = simboli[Math.floor(Math.random() * simboli.length)];

            let molt = 0;
            if (s1 === s2 && s2 === s3) molt = 5;
            else if (s1 === s2 || s2 === s3 || s1 === s3) molt = 2;

            if (molt > 0) {
                const nuovoSaldo = await modificaSaldo(user.id, (importo * molt) - importo);
                return interaction.reply({ content: `🎰 [ ${s1} | ${s2} | ${s3} ] — **VINTO!** +${(importo * molt).toLocaleString('it-IT')} € (Saldo: ${nuovoSaldo.toLocaleString('it-IT')} €)`, ephemeral: true });
            } else {
                const nuovoSaldo = await modificaSaldo(user.id, -importo);
                return interaction.reply({ content: `🎰 [ ${s1} | ${s2} | ${s3} ] — **PERSO!** -${importo.toLocaleString('it-IT')} € (Saldo: ${nuovoSaldo.toLocaleString('it-IT')} €)`, ephemeral: true });
            }
        }

        if (gioco === 'blackjack') {
            const carteG = [generaCarta(), generaCarta()];
            const carteB = [generaCarta(), generaCarta()];
            const pG = calcolaPuntiBlackjack(carteG);
            const pB = calcolaPuntiBlackjack(carteB);

            if (pG === 21 && pB !== 21) {
                const s = await modificaSaldo(user.id, Math.floor(importo * 2.5) - importo);
                return interaction.reply({ content: `🃏 **BLACKJACK!** Carte: ${carteG.join(' ')} (${pG}) vs Banco: ${carteB.join(' ')} (${pB}) | Vincita: +${Math.floor(importo * 2.5)} € | Saldo: ${s} €`, ephemeral: true });
            } else if (pG <= 21 && (pG > pB || pB > 21)) {
                const s = await modificaSaldo(user.id, importo);
                return interaction.reply({ content: `🃏 **VINTO!** Carte: ${carteG.join(' ')} (${pG}) vs Banco: ${carteB.join(' ')} (${pB}) | Vincita: +${importo * 2} € | Saldo: ${s} €`, ephemeral: true });
            } else if (pG === pB) {
                return interaction.reply({ content: `🃏 **PAREGGIO!** Carte: ${carteG.join(' ')} (${pG}) vs Banco: ${carteB.join(' ')} (${pB}) | Rimborso scommessa.`, ephemeral: true });
            } else {
                const s = await modificaSaldo(user.id, -importo);
                return interaction.reply({ content: `🃏 **PERSO!** Carte: ${carteG.join(' ')} (${pG}) vs Banco: ${carteB.join(' ')} (${pB}) | Saldo: ${s} €`, ephemeral: true });
            }
        }

        if (gioco === 'roulette') {
            const scommessa = options.getString('scommessa_roulette');
            const numPuntato = options.getInteger('numero_roulette');

            if (!scommessa && numPuntato === null) {
                return interaction.reply({ content: '⚠️ Specifica la scommessa o il numero!', ephemeral: true });
            }

            const num = Math.floor(Math.random() * 37);
            const rossi = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
            let col = num === 0 ? '🟢' : (rossi.includes(num) ? '🔴' : '⚫');

            let vinto = false;
            let molt = 0;

            if (numPuntato !== null && num === numPuntato) { vinto = true; molt = 36; }
            else if (scommessa === 'rosso' && col === '🔴') { vinto = true; molt = 2; }
            else if (scommessa === 'nero' && col === '⚫') { vinto = true; molt = 2; }
            else if (scommessa === 'pari' && num !== 0 && num % 2 === 0) { vinto = true; molt = 2; }
            else if (scommessa === 'dispari' && num !== 0 && num % 2 !== 0) { vinto = true; molt = 2; }
            else if (scommessa === 'zero' && num === 0) { vinto = true; molt = 36; }

            if (vinto) {
                const s = await modificaSaldo(user.id, (importo * molt) - importo);
                return interaction.reply({ content: `🎯 Risultato: ${col} **${num}** — **VINTO!** +${importo * molt} € | Saldo: ${s} €`, ephemeral: true });
            } else {
                const s = await modificaSaldo(user.id, -importo);
                return interaction.reply({ content: `🎯 Risultato: ${col} **${num}** — **PERSO!** -${importo} € | Saldo: ${s} €`, ephemeral: true });
            }
        }
    }

    if (commandName === 'classifica') {
        const res = await pool.query('SELECT user_id, saldo FROM conti WHERE ha_conto = 1 ORDER BY saldo DESC LIMIT 5');
        if (res.rows.length === 0) return interaction.reply({ content: 'Nessun conto presente.', ephemeral: true });

        let txt = '🏆 **TOP 5 CITTADINI PIÙ RICCHI**\n\n';
        res.rows.forEach((r, idx) => {
            txt += `${idx + 1}. <@${r.user_id}> — **${parseInt(r.saldo).toLocaleString('it-IT')} €**\n`;
        });
        return interaction.reply({ content: txt, ephemeral: true });
    }
});

// LOGIN
client.login(process.env.DISCORD_TOKEN);
