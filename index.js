require("dotenv").config();
const stringSimilarity = require("string-similarity");
const token = process.env.DISCORD_TOKEN;
const fs = require("node:fs");
const path = require("node:path");
const exclusionPath = "./exclusion_roles.json";

// スパム検知のための設定
const SPAM_THRESHOLD_MESSAGES = 3; // 3メッセージ（テスト用に下げる）
const SPAM_THRESHOLD_TIME_MS = 10000; // 10秒（テスト用に延長）
const SIMILARITY_THRESHOLD = 0.6; // 閾値を下げる（テスト用）
const userMessageHistory = new Map();

// レイド対策のための設定
const RAID_DETECTION_WINDOW = 5 * 60 * 1000; // 5分間のウィンドウ
const RAID_THRESHOLD_MULTIPLIER = 5; // 通常の5倍以上の参加者がいたらレイド判定
const MIN_RAID_MEMBERS = 5; // 最低5人以上の参加者がいないとレイド判定しない
const NORMAL_PERIOD_DAYS = 7; // 過去7日間の平均を「通常」として計算
const joinHistory = new Map(); // サーバーごとの参加履歴

const userMessageData = new Map(); // Mapを使用してユーザーごとのデータを保存
const raidModeStatus = new Map(); // サーバーごとのレイドモード状態を追跡

global.spamExclusionRoles = new Map();

if (fs.existsSync(exclusionPath)) {
    const data = JSON.parse(fs.readFileSync(exclusionPath, "utf-8"));
    for (const [guildId, roleIds] of Object.entries(data)) {
        global.spamExclusionRoles.set(guildId, new Set(roleIds));
    }
    console.log("スパム検知除外リストを読み込みました。");
}

// レイドモード状態をリセットする関数
function resetRaidMode(guildId) {
    raidModeStatus.delete(guildId);
    console.log(`レイドモード状態をリセットしました - Guild ID: ${guildId}`);
}

// スパム検知除外ロールのマップ
const spamExclusionRoles = new Map(); // サーバーID -> Set(ロールID)

// グローバルでアクセスできるようにする
global.resetRaidMode = resetRaidMode;
global.spamExclusionRoles = spamExclusionRoles;

const {
    Client,
    Collection,
    Events,
    GatewayIntentBits,
    MessageFlags,
    ChannelType, // ChannelType を追加
} = require("discord.js");

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages, // DM受信のために追加
    ],
});

client.commands = new Collection();

const foldersPath = path.join(__dirname, "commands");
const commandFolders = fs.readdirSync(foldersPath);

for (const folder of commandFolders) {
    const commandsPath = path.join(foldersPath, folder);
    const commandFiles = fs
        .readdirSync(commandsPath)
        .filter((file) => file.endsWith(".js"));
    for (const file of commandFiles) {
        const filePath = path.join(commandsPath, file);
        const command = require(filePath);
        if ("data" in command && "execute" in command) {
            client.commands.set(command.data.name, command);
        } else {
            console.log(
                `[あれ] ${filePath}のコマンドには、dataかexecuteのプロパティがないんだってさ。`,
            );
        }
    }
}

const homo_words = [
    "野獣先輩",
    "やじゅうせんぱい",
    "Beast Senpai",
    "beast senpai",
    "beast",
    "Beast",
    "野獣",
    "やじゅう",
    "ホモ",
    "ﾔｼﾞｭｾﾝﾊﾟｲｲｷｽｷﾞﾝｲｸｲｸｱｯｱｯｱｯｱｰﾔﾘﾏｽﾈ",
];

const soudayo = [
    "そうなの",
    "そうなん",
    "そうだよ",
    "そっかぁ",
    "そういうこと",
    "そうかも",
    "そうか",
    "そうっすね",
    "そうやで",
];

const abunai_words = [
    "死ね",
    "消えろ",
    "殺す",
    "殺して",
    "殺してやる",
    "障害者",
    "ガイジ",
    "がいじ",
    "知的障害",
    "きえろ",
    "ころす",
    "ころして",
    "ころしてやる",
    "しょうがいしゃ",
    "ちてきしょうがい",
    "!kiken",
];

// ここに危険なBotのIDを追加
const DANGEROUS_BOT_IDS = [
    "1363066479100170330",
    "1286667959397515355",
    "1371866834818826380",
    "1321414173602746419",
    "1349568375839264870",
    "1352599521032540190",
    "1378391189576876174",
    "1336633477868683305",
    "1352779479302410260",
    "1379825654035648555",
    "1386680498537107666",
];

const KAIJIDANA = [
    "開示",
    "開示だな",
    "音の出るゴミ",
    "震えて眠れ",
    "かいじ",
    "かいじだな",
    "おとのでるごみ",
    "ふるえてねむれ",
];

// アプリケーション使用時の悪意あるワード
const MALICIOUS_APP_WORDS = [
    "死ね",
    "殺す",
    "殺して",
    "消えろ",
    "ころす",
    "しね",
    "きえろ",
    "障害者",
    "ガイジ",
    "がいじ",
    "知的障害",
    "ちてきしょうがい",
    "バカ",
    "アホ",
    "ばか",
    "あほ",
    "うざい",
    "きもい",
    "気持ち悪い",
    "うんち",
    "うんこ",
    "クソ",
    "くそ",
    "ファック",
    "fuck",
    "shit",
    "bitch",
];

// 通常の参加者ペースを計算する関数
function calculateNormalJoinRate(guildId) {
    const history = joinHistory.get(guildId) || [];
    const now = Date.now();
    const normalPeriodStart = now - NORMAL_PERIOD_DAYS * 24 * 60 * 60 * 1000;

    const normalPeriodJoins = history.filter(
        (timestamp) => timestamp >= normalPeriodStart,
    );

    if (normalPeriodJoins.length === 0) {
        return 0;
    }

    const hoursInPeriod = (now - normalPeriodStart) / (60 * 60 * 1000);
    const avgJoinsPerHour = normalPeriodJoins.length / hoursInPeriod;
    return avgJoinsPerHour * (5 / 60);
}

// レイド検知関数
async function checkForRaid(guild) {
    const guildId = guild.id;
    const history = joinHistory.get(guildId) || [];
    const now = Date.now();
    const windowStart = now - RAID_DETECTION_WINDOW;

    const recentJoins = history.filter((timestamp) => timestamp >= windowStart);
    const recentJoinCount = recentJoins.length;

    const normalRate = calculateNormalJoinRate(guildId);
    const threshold = Math.max(
        normalRate * RAID_THRESHOLD_MULTIPLIER,
        MIN_RAID_MEMBERS,
    );

    console.log(`レイド検知チェック - サーバー: ${guild.name}`);
    console.log(`過去5分間の参加者数: ${recentJoinCount}`);
    console.log(`通常の5分間参加者数: ${normalRate.toFixed(2)}`);
    console.log(`レイド判定閾値: ${threshold.toFixed(2)}`);

    if (recentJoinCount >= threshold) {
        console.log(`レイド検知！ サーバー: ${guild.name}`);
        await activateRaidMode(guild);
    }
}

// レイドモード有効化関数
async function activateRaidMode(guild) {
    try {
        const guildId = guild.id;

        if (raidModeStatus.get(guildId)) {
            console.log(`レイドモードは既に有効です - サーバー: ${guild.name}`);
            return;
        }

        let raidGuardRole = guild.roles.cache.find(
            (role) => role.name === "RaidGuard_AuAu",
        );

        const isNewRaidMode = !raidGuardRole;

        if (!raidGuardRole) {
            raidGuardRole = await guild.roles.create({
                name: "RaidGuard_AuAu",
                color: "#FF0000",
                reason: "レイド対策用制限ロール",
            });
            console.log(`RaidGuard_AuAuロールを作成しました`);

            guild.channels.cache.forEach(async (channel) => {
                if (
                    channel.type === ChannelType.GuildText ||
                    channel.type === ChannelType.GuildVoice
                ) {
                    try {
                        await channel.permissionOverwrites.create(
                            raidGuardRole,
                            {
                                SendMessages: false,
                                AddReactions: false,
                                SendMessagesInThreads: false,
                                CreatePublicThreads: false,
                                CreatePrivateThreads: false,
                            },
                        );
                    } catch (error) {
                        console.error(
                            `チャンネル ${channel.name} の権限設定に失敗:`,
                            error,
                        );
                    }
                }
            });
        }

        raidModeStatus.set(guildId, true);

        const now = Date.now();
        const recentJoinThreshold = now - RAID_DETECTION_WINDOW;

        const recentMembers = guild.members.cache.filter(
            (member) =>
                member.joinedTimestamp >= recentJoinThreshold &&
                !member.user.bot &&
                !member.roles.cache.has(raidGuardRole.id),
        );

        for (const [, member] of recentMembers) {
            try {
                await member.roles.add(raidGuardRole);
                console.log(
                    `${member.user.username} にRaidGuard_AuAuロールを付与しました`,
                );
            } catch (error) {
                console.error(
                    `${member.user.username} へのロール与に失敗:`,
                    error,
                );
            }
        }

        if (isNewRaidMode) {
            let logChannel = guild.channels.cache.find(
                (channel) =>
                    channel.name === "auau-log" &&
                    channel.type === ChannelType.GuildText,
            );

            if (!logChannel) {
                logChannel = await guild.channels.create({
                    name: "auau-log",
                    type: ChannelType.GuildText,
                    permissionOverwrites: [
                        {
                            id: guild.roles.everyone,
                            deny: ["ViewChannel"],
                        },
                        {
                            id: client.user.id,
                            allow: ["ViewChannel", "SendMessages"],
                        },
                    ],
                    reason: "レイド対策ログ用チャンネルを作成",
                });
                console.log(`auau-log チャンネルを作成しました。`);
            }

            await logChannel.send(
                `⚠️ **異常な参加ペースを検知しました！**\n` +
                    `現在、いつもより明らかに早いスピードで新規メンバーが参加しています。\n` +
                    `あなたのサーバーが **Raidの標的**になっている可能性があります。\n` +
                    `🛡️ セキュリティモードを自動で有効化し、**新規メンバー全員に \`RaidGuard_AuAu\` ロール**を付与しました。\n` +
                    `**対応方法：**\n` +
                    `- 様子を見て問題が落ち着いたら \`/unmute_raid\` コマンドを実行してください。\n` +
                    `- それまでは新規参加者を**慎重に監視**してください。\n` +
                    `- ❇️落ち着くことも重要です。 冷静な判断を下すためにアイスティーを飲みながら警戒するのをおすすめします。\n` +
                    `*（by あうあうBot）*`,
            );
        }
    } catch (error) {
        console.error("レイドモード有効化中にエラーが発生しました:", error);
    }
}

client.on("ready", () => {
    console.log(`${client.user.tag}でログインしました!!`);
});

client.on(Events.GuildCreate, async (guild) => {
    try {
        console.log(`新しいサーバーに参加しました: ${guild.name}`);

        let logChannel = guild.channels.cache.find(
            (channel) =>
                channel.name === "auau-log" &&
                channel.type === ChannelType.GuildText,
        );

        if (!logChannel) {
            logChannel = await guild.channels.create({
                name: "auau-log",
                type: ChannelType.GuildText,
                permissionOverwrites: [
                    {
                        id: guild.roles.everyone,
                        deny: ["ViewChannel"],
                    },
                    {
                        id: client.user.id,
                        allow: ["ViewChannel", "SendMessages"],
                    },
                ],
                reason: "あうあうBot初期化 - ログチャンネル作成",
            });
            console.log(`auau-logチャンネルを作成しました`);
        }

        let muteRole = guild.roles.cache.find(
            (role) => role.name === "Muted_AuAu",
        );
        if (!muteRole) {
            muteRole = await guild.roles.create({
                name: "Muted_AuAu",
                color: "#808080",
                reason: "あうあうBot初期化 - ミュートロール作成",
            });
            console.log(`Muted_AuAuロールを作成しました`);
        }

        let raidGuardRole = guild.roles.cache.find(
            (role) => role.name === "RaidGuard_AuAu",
        );
        if (!raidGuardRole) {
            raidGuardRole = await guild.roles.create({
                name: "RaidGuard_AuAu",
                color: "#FF0000",
                reason: "あうあうBot初期化 - レイドガードロール作成",
            });
            console.log(`RaidGuard_AuAuロールを作成しました`);
        }

        let appRestrictRole = guild.roles.cache.find(
            (role) => role.name === "AppRestrict_AuAu",
        );
        if (!appRestrictRole) {
            appRestrictRole = await guild.roles.create({
                name: "AppRestrict_AuAu",
                color: "#FFA500",
                reason: "あうあうBot初期化 - アプリケーション制限ロール作成",
            });
            console.log(`AppRestrict_AuAuロールを作成しました`);
        }

        await new Promise((resolve) => setTimeout(resolve, 1000));

        const channels = guild.channels.cache.filter(
            (channel) =>
                channel.type === ChannelType.GuildText ||
                channel.type === ChannelType.GuildVoice,
        );

        for (const [, channel] of channels) {
            try {
                const botMember = guild.members.cache.get(client.user.id);
                if (
                    !channel
                        .permissionsFor(botMember)
                        .has(["ManageRoles", "ManageChannels"])
                ) {
                    console.log(
                        `チャンネル ${channel.name} の権限設定をスキップ: 権限不足`,
                    );
                    continue;
                }

                await channel.permissionOverwrites.create(muteRole, {
                    SendMessages: false,
                    Speak: false,
                    AddReactions: false,
                    SendMessagesInThreads: false,
                    CreatePublicThreads: false,
                    CreatePrivateThreads: false,
                });

                await channel.permissionOverwrites.create(raidGuardRole, {
                    SendMessages: false,
                    AddReactions: false,
                    SendMessagesInThreads: false,
                    CreatePublicThreads: false,
                    CreatePrivateThreads: false,
                });

                console.log(`チャンネル ${channel.name} の権限設定完了`);

                await new Promise((resolve) => setTimeout(resolve, 200));
            } catch (error) {
                if (error.code === 50001 || error.code === 50013) {
                    console.log(
                        `チャンネル ${channel.name} の権限設定をスキップ: ${error.message}`,
                    );
                } else {
                    console.error(
                        `チャンネル ${channel.name} の権限設定に失敗:`,
                        error,
                    );
                }
            }
        }

        await logChannel.send({
            content:
                `やあ！屋上あんだけど…焼いてかない...？\n` +
                `Botの導入ありがとうございます、あうあうBotのロールの順位をなるべく高くして、\n` +
                `その下にRaidGuard_AuAuロール、Muted_AuAuロールを設置してください。\n` +
                `現在はおそらく権限の問題でチャンネルにロールが付いてないと思うので、上を行ってから/resetupコマンドの実行をお願いします`,
            files: ["https://i.imgur.com/hoaV8id.gif"],
        });

        console.log(`${guild.name} への初期化が完了しました`);
    } catch (error) {
        console.error(
            "サーバー参加時の初期化処理でエラーが発生しました:",
            error,
        );
    }
});

// コマンドのクールダウン時間を設定 (ミリ秒)
const COMMAND_COOLDOWN_TIME = 15000; // 例: 3秒

// ユーザu��ごとのコマンドクールダウンを記録するMap
const commandCooldowns = new Map(); // userId -> { commandName -> lastExecuted }

client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const command = interaction.client.commands.get(interaction.commandName);

    if (!command) {
        console.error(
            `${interaction.commandName}に一致するコマンドが見つかんなかったよ。`,
        );
        return;
    }

    // クールダウンチェック
    const userId = interaction.user.id;
    const commandName = interaction.commandName;
    const now = Date.now();

    if (!commandCooldowns.has(userId)) {
        commandCooldowns.set(userId, {});
    }

    const userCooldowns = commandCooldowns.get(userId);
    const lastExecuted = userCooldowns[commandName] || 0;
    const timeDiff = now - lastExecuted;

    if (timeDiff < COMMAND_COOLDOWN_TIME) {
        const remainingTime = Math.ceil(
            (COMMAND_COOLDOWN_TIME - timeDiff) / 1000,
        );
        await interaction.reply({
            content: `⏰ コマンドのクールダウン中です。あと ${remainingTime} 秒お待ちください。`,
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    // クールダウンを更新
    userCooldowns[commandName] = now;
    commandCooldowns.set(userId, userCooldowns);

    try {
        await command.execute(interaction);
    } catch (error) {
        console.error(error);
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({
                content: "コマンド実行してるときにエラー出たんだってさ。",
                flags: MessageFlags.Ephemeral,
            });
        } else {
            await interaction.reply({
                content: "コマンド実行してるときにエラー出たんだってさ。",
                flags: MessageFlags.Ephemeral,
            });
        }
    }
});

client.on(Events.GuildMemberAdd, async (member) => {
    const guildId = member.guild.id;
    const now = Date.now();

    if (!joinHistory.has(guildId)) {
        joinHistory.set(guildId, []);
    }

    const history = joinHistory.get(guildId);
    history.push(now);

    const sevenDaysAgo = now - NORMAL_PERIOD_DAYS * 24 * 60 * 60 * 1000;
    const cleanHistory = history.filter(
        (timestamp) => timestamp >= sevenDaysAgo,
    );
    joinHistory.set(guildId, cleanHistory);

    if (member.user.bot) {
        if (DANGEROUS_BOT_IDS.includes(member.user.id)) {
            try {
                await member.ban({ reason: "危険なBotのため自動BAN" });
                console.log(
                    `危険なBot ${member.user.tag} (${member.user.id}) をBANしました。`,
                );

                let logChannel = member.guild.channels.cache.find(
                    (channel) =>
                        channel.name === "auau-log" &&
                        channel.type === ChannelType.GuildText,
                );

                if (!logChannel) {
                    logChannel = await member.guild.channels.create({
                        name: "auau-log",
                        type: ChannelType.GuildText,
                        permissionOverwrites: [
                            {
                                id: member.guild.roles.everyone,
                                deny: ["ViewChannel"],
                            },
                            {
                                id: client.user.id,
                                allow: ["ViewChannel", "SendMessages"],
                            },
                        ],
                        reason: "危険なBotのログ用チャンネルを作成",
                    });
                    console.log(`auau-log チャンネルを作成しました。`);
                }

                await logChannel.send(
                    `:rotating_light: **危険なBot検知 & BAN** :rotating_light:\n` +
                        `Botの名前: ${member.user.tag}\n` +
                        `BotのID: \`${member.user.id}\`\n` +
                        `理由: 危険なBotリストに含まれていたため、自動的にBANしました。`,
                );
            } catch (error) {
                console.error(
                    `危険なBot (${member.user.id}) のBANまたはログ送信中にエラーが発生しました:`,
                    error,
                );
            }
        }
    } else {
        await checkForRaid(member.guild);

        const raidGuardRole = member.guild.roles.cache.find(
            (role) => role.name === "RaidGuard_AuAu",
        );
        const isRaidMode = raidModeStatus.get(guildId); // ← 追加

        if (raidGuardRole && isRaidMode) {
            // ← 条件付きで付与
            try {
                await member.roles.add(raidGuardRole);
                console.log(
                    `新規参加者 ${member.user.username} にRaidGuard_AuAuロールを付与しました`,
                );
            } catch (error) {
                console.error(
                    `新規参加者へのRaidGuard_AuAuロール付与に失敗:`,
                    error,
                );
            }
        }
    }
});

client.on(Events.ChannelCreate, async (channel) => {
    if (
        channel.type === ChannelType.GuildText ||
        channel.type === ChannelType.GuildVoice
    ) {
        const muteRole = channel.guild.roles.cache.find(
            (role) => role.name === "Muted_AuAu",
        );

        if (muteRole) {
            try {
                await channel.permissionOverwrites.create(muteRole, {
                    SendMessages: false,
                    Speak: false,
                    AddReactions: false,
                    SendMessagesInThreads: false,
                    CreatePublicThreads: false,
                });
                console.log(
                    `新しいチャンネル ${channel.name} にMuted_AuAuロールの権限を設定しました`,
                );
            } catch (error) {
                console.error(
                    `チャンネル ${channel.name} の権限設定に失敗:`,
                    error,
                );
            }
        }

        const raidGuardRole = channel.guild.roles.cache.find(
            (role) => role.name === "RaidGuard_AuAu",
        );

        if (raidGuardRole) {
            try {
                await channel.permissionOverwrites.create(raidGuardRole, {
                    SendMessages: false,
                    AddReactions: false,
                    SendMessagesInThreads: false,
                    CreatePublicThreads: false,
                    CreatePrivateThreads: false,
                });
                console.log(
                    `新しいチャンネル ${channel.name} にRaidGuard_AuAuロールの権限を設定しました`,
                );
            } catch (error) {
                console.error(
                    `チャンネル ${channel.name} のRaidGuard_AuAu権限設定に失敗:`,
                    error,
                );
            }
        }
    }
});

client.on("messageCreate", async (msg) => {
    if (msg.author.bot) return;

    // DMメッセージの処理
    if (msg.channel.type === ChannelType.DM) {
        const args = msg.content.trim().split(/\s+/);
        if (args.length === 3 && args[2] === "unmute_rec") {
            const userId = args[0];
            const guildId = args[1];

            // 入力の検証
            if (!/^\d{17,19}$/.test(userId) || !/^\d{17,19}$/.test(guildId)) {
                await msg.reply(
                    "無効なユーザーIDまたはサーバーIDです。正しい形式で入力してください。\n例: `123456789012345678 123456789012345678 unmute_rec`",
                );
                return;
            }

            try {
                const guild = await client.guilds.fetch(guildId);
                const member = await guild.members.fetch(userId);
                const muteRole = guild.roles.cache.find(
                    (role) => role.name === "Muted_AuAu",
                );

                if (!muteRole) {
                    await msg.reply(
                        `サーバー ${guild.name} にMuted_AuAuロールが見つかりません。`,
                    );
                    return;
                }

                if (!member.roles.cache.has(muteRole.id)) {
                    await msg.reply(
                        `${member.user.username} は既にミュートされていません。`,
                    );
                    return;
                }

                await member.roles.remove(muteRole);
                await msg.reply(
                    `${guild.name} の ${member.user.username} のミュートを解除しました。`,
                );
                console.log(
                    `DM経由で ${guild.name} の ${member.user.username} のMuted_AuAuロールを解除しました`,
                );

                // ログチャンネルに通知
                let logChannel = guild.channels.cache.find(
                    (channel) =>
                        channel.name === "auau-log" &&
                        channel.type === ChannelType.GuildText,
                );

                if (logChannel) {
                    await logChannel.send(
                        `🔔 **ミュート解除通知**\n` +
                            `ユーザー: ${member.user.username} (ID: ${userId})\n` +
                            `DM経由でMuted_AuAuロールを解除しました。`,
                    );
                }
            } catch (error) {
                console.error(
                    "DM経由のミュート解除中にエラーが発生しました:",
                    error,
                );
                await msg.reply(
                    "ミュート解除に失敗しました。ユーザーまたはサーバーが見つからないか、権限が不足しています。",
                );
            }
        } else {
            await msg.reply(
                "無効なコマンドです。形式: `ユーザーID サーバーID unmute_rec`\n例: `123456789012345678 123456789012345678 unmute_rec`",
            );
        }
        return;
    }

    // スパム検知除外ロールをチェック
    const guildId = msg.guild.id;
    const exclusionRoles = spamExclusionRoles.get(guildId);

    if (exclusionRoles && exclusionRoles.size > 0) {
        const member = msg.guild.members.cache.get(msg.author.id);
        if (member) {
            const hasExclusionRole = member.roles.cache.some((role) =>
                exclusionRoles.has(role.id),
            );
            if (hasExclusionRole) {
                console.log(
                    `スパム検知をスキップ: ${msg.author.username} (除外ロール所持)`,
                );
                await processNonSpamMessage(msg);
                return;
            }
        }
    }

    const userId = msg.author.id;
    const now = Date.now();

    if (!userMessageHistory.has(userId)) {
        userMessageHistory.set(userId, []);
    }

    const history = userMessageHistory.get(userId);
    const cleanHistory = history.filter(
        (entry) => now - entry.timestamp < SPAM_THRESHOLD_TIME_MS,
    );

    let similarCount = 1;

    for (const entry of cleanHistory) {
        const similarity = stringSimilarity.compareTwoStrings(
            msg.content,
            entry.content,
        );
        console.log(
            `類似度チェック: "${msg.content}" vs "${entry.content}" = ${similarity}`,
        );
        if (similarity >= SIMILARITY_THRESHOLD) {
            similarCount++;
        }
    }

    cleanHistory.push({ content: msg.content, timestamp: now });
    userMessageHistory.set(userId, cleanHistory);

    console.log(
        `ユーザー ${msg.author.username}: 類似メッセージ数 = ${similarCount}`,
    );

    if (similarCount >= SPAM_THRESHOLD_MESSAGES) {
        console.log(
            `スパム検知！ユーザー: ${msg.author.username}, 類似メッセージ数: ${similarCount}`,
        );
        try {
            await msg.delete();

            let muteRole = msg.guild.roles.cache.find(
                (role) => role.name === "Muted_AuAu",
            );

            if (!muteRole) {
                muteRole = await msg.guild.roles.create({
                    name: "Muted_AuAu",
                    color: "#808080",
                    reason: "スパム対策用ミュートロール",
                });
                console.log(`Muted_AuAuロールを作成しました`);

                msg.guild.channels.cache.forEach(async (channel) => {
                    if (
                        channel.type === ChannelType.GuildText ||
                        channel.type === ChannelType.GuildVoice
                    ) {
                        try {
                            await channel.permissionOverwrites.create(
                                muteRole,
                                {
                                    SendMessages: false,
                                    Speak: false,
                                    AddReactions: false,
                                    SendMessagesInThreads: false,
                                    CreatePublicThreads: false,
                                    CreatePrivateThreads: false,
                                },
                            );
                        } catch (error) {
                            console.error(
                                `チャンネル ${channel.name} の権限設定に失敗:`,
                                error,
                            );
                        }
                    }
                });
            }

            const member = msg.guild.members.cache.get(msg.author.id);
            if (member && !member.roles.cache.has(muteRole.id)) {
                await member.roles.add(muteRole);
                console.log(
                    `${msg.author.username} にMuted_AuAuロールを付与しました`,
                );
            }

            const warn = await msg.channel.send(
                `${msg.author} 類似メッセージの連投を検知しました（${similarCount}件）\n` +
                    `自動的にミュートロールが付与されました。管理者にお問い合わせください。`,
            );
            setTimeout(() => warn.delete().catch(() => {}), 10000);

            return;
        } catch (err) {
            console.error("スパム処理失敗:", err);
        }
    }

    await processNonSpamMessage(msg);
});

// アプリケーション使用検知とロール付与機能
client.on(Events.InteractionCreate, async (interaction) => {
    // アプリケーションコマンドの使用を検知
    if (interaction.isCommand() || interaction.isApplicationCommand()) {
        const user = interaction.user;
        const guild = interaction.guild;
        
        if (!guild) return; // DMでは処理しない
        
        // コマンドの内容をチェック
        let contentToCheck = '';
        
        // スラッシュコマンドの場合
        if (interaction.commandName) {
            contentToCheck += interaction.commandName + ' ';
        }
        
        // オプションがある場合
        if (interaction.options && interaction.options.data) {
            for (const option of interaction.options.data) {
                if (option.value && typeof option.value === 'string') {
                    contentToCheck += option.value + ' ';
                }
            }
        }
        
        // 悪意あるワードをチェック
        const containsMaliciousWord = MALICIOUS_APP_WORDS.some(word => 
            contentToCheck.toLowerCase().includes(word.toLowerCase())
        );
        
        if (containsMaliciousWord) {
            try {
                console.log(`アプリケーション使用時の悪意あるワード検知: ${user.username} - "${contentToCheck}"`);
                
                // AppRestrict_AuAuロールを取得または作成
                let restrictRole = guild.roles.cache.find(role => role.name === 'AppRestrict_AuAu');
                
                if (!restrictRole) {
                    restrictRole = await guild.roles.create({
                        name: 'AppRestrict_AuAu',
                        color: '#FFA500',
                        reason: 'アプリケーション使用制限ロール'
                    });
                    console.log(`AppRestrict_AuAuロールを作成しました`);
                }
                
                const member = guild.members.cache.get(user.id);
                if (member && !member.roles.cache.has(restrictRole.id)) {
                    await member.roles.add(restrictRole);
                    console.log(`${user.username} にAppRestrict_AuAuロールを付与しました`);
                    
                    // ログチャンネルに通知
                    let logChannel = guild.channels.cache.find(channel => 
                        channel.name === 'auau-log' && channel.type === ChannelType.GuildText
                    );
                    
                    if (logChannel) {
                        await logChannel.send(
                            `🚨 **アプリケーション使用時の悪意あるワード検知**\n` +
                            `ユーザー: ${user.username} (${user.id})\n` +
                            `検知内容: "${contentToCheck}"\n` +
                            `AppRestrict_AuAuロールを付与しました。`
                        );
                    }
                }
                
                // 元のインタラクションにエラーメッセージを送信
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content: '⚠️ 不適切な内容が検出されました。アプリケーション使用制限ロールが付与されました。',
                        ephemeral: true
                    });
                }
                
            } catch (error) {
                console.error('アプリケーション制限ロール付与中にエラーが発生しました:', error);
            }
        }
    }
});

// スパム検知以外のメッセージ処理を行う関数
async function processNonSpamMessage(msg) {
    const messageContentLower = msg.content.toLowerCase();
    const containsAnyWord = (wordList) =>
        wordList.some((word) =>
            messageContentLower.includes(word.toLowerCase()),
        );

    if (msg.content === "!ping") {
        msg.reply("Botは応答してるよ!");
    } else if (msg.content.startsWith("!unmute")) {
        if (!msg.member.permissions.has("MANAGE_ROLES")) {
            msg.reply("このコマンドを使用する権限がありません。");
            return;
        }

        const mentionedUser = msg.mentions.users.first();
        if (!mentionedUser) {
            msg.reply(
                "ミュートを解除するユーザーをメンションしてください。\n使用法: `!unmute @ユーザー名`",
            );
            return;
        }

        const member = msg.guild.members.cache.get(mentionedUser.id);
        const muteRole = msg.guild.roles.cache.find(
            (role) => role.name === "Muted_AuAu",
        );

        if (!member) {
            msg.reply("指定されたユーザーがサーバーに見つかりません。");
            return;
        }

        if (!muteRole) {
            msg.reply("Muted_AuAuロールが見つかりません。");
            return;
        }

        if (!member.roles.cache.has(muteRole.id)) {
            msg.reply("指定されたユーザーはミュートされていません。");
            return;
        }

        try {
            await member.roles.remove(muteRole);
            msg.reply(`${mentionedUser.username} のミュートを解除しました。`);
            console.log(
                `${msg.author.username} が ${mentionedUser.username} のミュートを解除しました`,
            );
        } catch (error) {
            console.error("ミュート解除失敗:", error);
            msg.reply("ミュートの解除に失敗しました。");
        }
    } else if (containsAnyWord(homo_words)) {
        msg.reply(":warning: 淫夢発言を検知しました！！ :warning:");
    } else if (containsAnyWord(soudayo)) {
        msg.reply("そうだよ(便乗)");
    } else if (containsAnyWord(abunai_words)) {
        try {
            const warningMessage = await msg.reply(
                `:warning: 危険発言を検知しました！！:warning:\nhttps://i.imgur.com/IEq6RPc.jpeg`,
            );
            setTimeout(() => {
                msg.delete().catch((err) =>
                    console.error("元のメッセージの削除に失敗しました:", err),
                );
            }, 100);
        } catch (error) {
            console.error(
                "危険発言を含むメッセージの処理中にエラーが発生しました:",
                error,
            );
        }
    } else if (containsAnyWord(KAIJIDANA)) {
        msg.reply("https://i.imgur.com/kSCMoPg.jpeg");
    }
}

client.login(token);
