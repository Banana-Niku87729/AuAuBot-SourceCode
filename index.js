require("dotenv").config();
console.log("[CHECK] index.js 開始");
const stringSimilarity = require("string-similarity");
const token = process.env.DISCORD_TOKEN;
const fs = require("node:fs");
const path = require("node:path");
const exclusionPath = "./exclusion_roles.json";
const authPanel = require("./commands/aaa/auth-panel.js");
const { Player } = require("discord-player");

// スパム検知のための設定 - 既存の設定を置き換え
const SPAM_THRESHOLD_MESSAGES = 3;
const SPAM_THRESHOLD_TIME_MS = 10000;
const SIMILARITY_THRESHOLD = 0.6;
const userMessageHistory = new Map();

// 語録反応用クールダウン設定
const GOROKU_COOLDOWN_TIME = 10000;
const gorokuCooldowns = new Map();

// スレッドスパム検知のための設定 - 新規追加
const THREAD_SPAM_THRESHOLD_OPERATIONS = 3; // デフォルト: 3回の操作
const THREAD_SPAM_THRESHOLD_TIME_MS = 30000; // デフォルト: 30秒
const THREAD_SPAM_TIMEOUT_DURATION = 600000; // デフォルト: 10分（ミリ秒）
const userThreadHistory = new Map(); // ユーザーごとのスレッド操作履歴

// グローバル設定保存用
global.threadSpamSettings = new Map(); // サーバーごとのスレッドスパム設定

// レイド対策のための設定
const RAID_DETECTION_WINDOW = 5 * 60 * 1000; // 5分間のウィンドウ
const RAID_THRESHOLD_MULTIPLIER = 5; // 通常の5倍以上の参加者がいたらレイド判定
const MIN_RAID_MEMBERS = 5; // 最低5人以上の参加者がいないとレイド判定しない
const NORMAL_PERIOD_DAYS = 7; // 過去7日間の平均を「通常」として計算
const joinHistory = new Map(); // サーバーごとの参加履歴

const userMessageData = new Map(); // Mapを使用してユーザーごとのデータを保存
const raidModeStatus = new Map(); // サーバーごとのレイドモード状態を追跡
const express = require("express");
const app = express();
const PORT = process.env.PORT;

console.log("[CHECK] Renderから渡されたPORT:", PORT);

global.spamExclusionRoles = new Map();

if (fs.existsSync(exclusionPath)) {
    const data = JSON.parse(fs.readFileSync(exclusionPath, "utf-8"));
    for (const [guildId, roleData] of Object.entries(data)) {
        const spamRoles = Array.isArray(roleData)
            ? roleData // ← 旧形式（単一配列）
            : roleData.spam || []; // ← 新形式の spam 配列

        global.spamExclusionRoles.set(guildId, new Set(spamRoles));
    }
    console.log("スパム検知除外リストを読み込みました。");
}

// レイドモード状態をリセットする関数
function resetRaidMode(guildId) {
    raidModeStatus.delete(guildId);
    console.log(`レイドモード状態をリセットしました - Guild ID: ${guildId}`);
}

// スレッドスパム検知関数 - 新規追加
async function checkThreadSpam(member, guild) {
    const userId = member.id;
    const guildId = guild.id;
    const now = Date.now();

    // サーバー固有の設定を取得
    const serverSettings = global.threadSpamSettings.get(guildId) || {
        threshold: THREAD_SPAM_THRESHOLD_OPERATIONS,
        timeWindow: THREAD_SPAM_THRESHOLD_TIME_MS,
        timeoutDuration: THREAD_SPAM_TIMEOUT_DURATION,
    };

    if (!userThreadHistory.has(userId)) {
        userThreadHistory.set(userId, []);
    }

    const history = userThreadHistory.get(userId);

    // 時間枠内の操作のみを保持
    const cleanHistory = history.filter(
        (entry) =>
            now - entry.timestamp < serverSettings.timeWindow &&
            entry.guildId === guildId,
    );

    // 新しい操作を追加
    cleanHistory.push({ timestamp: now, guildId: guildId });
    userThreadHistory.set(userId, cleanHistory);

    console.log(
        `スレッド操作チェック: ${member.user.username} - 操作数: ${cleanHistory.length}/${serverSettings.threshold}`,
    );

    // 閾値を超えた場合
    if (cleanHistory.length >= serverSettings.threshold) {
        console.log(`スレッドスパム検知！ユーザー: ${member.user.username}`);

        try {
            // タイムアウトを実行
            await member.timeout(
                serverSettings.timeoutDuration,
                "スレッドスパム検知による自動タイムアウト",
            );

            // ログチャンネルに通知
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
                    reason: "スレッドスパム検知ログ用チャンネルを作成",
                });
            }

            const timeoutMinutes = Math.ceil(
                serverSettings.timeoutDuration / 60000,
            );
            await logChannel.send(
                `🚨 **スレッドスパム検知 & 自動タイムアウト** 🚨\n` +
                    `ユーザー: ${member.user.username} (${member.user.id})\n` +
                    `検知内容: ${Math.floor(serverSettings.timeWindow / 1000)}秒間に${cleanHistory.length}回のスレッド操作\n` +
                    `タイムアウト時間: ${timeoutMinutes}分\n` +
                    `自動的にタイムアウトしました。`,
            );

            // 履歴をクリア
            userThreadHistory.delete(userId);

            return true; // スパム検知したことを返す
        } catch (error) {
            console.error(`スレッドスパムタイムアウト失敗 (${userId}):`, error);
        }
    }

    return false;
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
        GatewayIntentBits.GuildVoiceStates,
    ],
});

client.commands = new Collection();

const foldersPath = path.join(__dirname, "commands");
const commandFolders = fs.readdirSync(foldersPath);
const player = new Player(client);
client.player = player;

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
    "アイスティーしかなかったけどいいかな？",
    "枕がデカすぎ",
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
    "RAID BY OZEU",
    "discord.gg/ozeu",
    "discord.gg/ozeu-x",
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
    "RAID BY OZEU",
    "discord.gg/ozeu",
    "discord.gg/ozeu-x",
];

const matakayo = ["なんだよもう", "なんだよ", "またかよ"];

// NukeBot検知のための設定
const NUKEBOT_DETECTION_WINDOW = 2 * 60 * 1000; // 2分間のウィンドウ
const NUKEBOT_ROLE_THRESHOLD = 10; // 2分間で10個以上のロール操作
const NUKEBOT_CHANNEL_THRESHOLD = 5; // 2分間で5個以上のチャンネル操作
const nukeBotHistory = new Map(); // Bot IDごとの操作履歴

// NukeBot検知用の操作履歴を記録する関数
function recordBotActivity(botId, guildId, activityType) {
    const now = Date.now();
    const key = `${botId}-${guildId}`;

    if (!nukeBotHistory.has(key)) {
        nukeBotHistory.set(key, {
            roleActions: [],
            channelActions: [],
        });
    }

    const history = nukeBotHistory.get(key);
    const windowStart = now - NUKEBOT_DETECTION_WINDOW;

    if (activityType === "role") {
        history.roleActions = history.roleActions.filter(
            (timestamp) => timestamp >= windowStart,
        );
        history.roleActions.push(now);
    } else if (activityType === "channel") {
        history.channelActions = history.channelActions.filter(
            (timestamp) => timestamp >= windowStart,
        );
        history.channelActions.push(now);
    }

    nukeBotHistory.set(key, history);
    return history;
}

// NukeBot検知関数
async function checkForNukeBot(guild, botUser, activityType) {
    const history = recordBotActivity(botUser.id, guild.id, activityType);

    const roleActionsCount = history.roleActions.length;
    const channelActionsCount = history.channelActions.length;

    console.log(
        `NukeBot検知チェック - Bot: ${botUser.username}, ロール操作: ${roleActionsCount}, チャンネル操作: ${channelActionsCount}`,
    );

    if (
        roleActionsCount >= NUKEBOT_ROLE_THRESHOLD ||
        channelActionsCount >= NUKEBOT_CHANNEL_THRESHOLD
    ) {
        console.log(`NukeBot検知！ Bot: ${botUser.username} (${botUser.id})`);
        await banNukeBot(guild, botUser, roleActionsCount, channelActionsCount);
    }
}

// NukeBotをBANする関数
async function banNukeBot(guild, botUser, roleCount, channelCount) {
    try {
        const member = guild.members.cache.get(botUser.id);
        if (!member) return;

        await member.ban({
            reason: `NukeBot検知: 2分間でロール操作${roleCount}回、チャンネル操作${channelCount}回`,
        });

        console.log(
            `NukeBot ${botUser.username} (${botUser.id}) をBANしました`,
        );

        // ログチャンネルに通知
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
                reason: "NukeBot検知ログ用チャンネルを作成",
            });
        }

        await logChannel.send(
            `🚨 **NukeBot検知 & 自動BAN** 🚨\n` +
                `Bot名: ${botUser.username}\n` +
                `BotID: \`${botUser.id}\`\n` +
                `検知理由: 2分間で異常な操作を検知\n` +
                `- ロール操作: ${roleCount}回\n` +
                `- チャンネル操作: ${channelCount}回\n` +
                `自動的にBANしました。サーバーを保護しています。`,
        );
    } catch (error) {
        console.error(
            `NukeBot (${botUser.id}) のBAN中にエラーが発生しました:`,
            error,
        );
    }
}

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
        console.error("レイドモード有効化中にエn��ーが発生しました:", error);
    }
}

async function updatePresence() {
    const serverCount = client.guilds.cache.size;
    await client.user.setPresence({
        activities: [
            { name: `${serverCount}個のサーバーで汚物を投下中!`, type: 0 },
        ],
        status: "online",
    });
}

function initializeExclusionRoles() {
    try {
        if (fs.existsSync("./exclusion_roles.json")) {
            const data = JSON.parse(
                fs.readFileSync("./exclusion_roles.json", "utf8"),
            );
            global.exclusionRoles = new Map();
            global.spamExclusionRoles = new Map();

            for (const [guildId, roles] of Object.entries(data)) {
                const convertedRoles = {
                    spam: new Set(roles.spam || []),
                    profanity: new Set(roles.profanity || []),
                    inmu: new Set(roles.inmu || []),
                    link: new Set(roles.link || []),
                    threadSpam: new Set(roles.threadSpam || []), // 新規追加
                    profanityDetection: new Set(roles.profanityDetection || []), // 新規追加
                };
                global.exclusionRoles.set(guildId, convertedRoles);
                global.spamExclusionRoles.set(guildId, convertedRoles.spam);
            }
            console.log("除外ロール設定を読み込みました");
        } else {
            global.exclusionRoles = new Map();
            global.spamExclusionRoles = new Map();
            console.log(
                "除外ロール設定ファイルが見つかりません。新規作成します。",
            );
        }
    } catch (error) {
        console.error("除外ロール設定の読み込みに失敗しました:", error);
        global.exclusionRoles = new Map();
        global.spamExclusionRoles = new Map();
    }
}

client.on("ready", updatePresence);
client.on("guildCreate", updatePresence);
client.on("guildDelete", updatePresence);

client.on("ready", () => {
    console.log(`${client.user.tag}でログインしました!!`);

    initializeExclusionRoles();

    const activities = [
        () => `${client.guilds.cache.size}個のサーバーで汚物を投下中!`,
        () => `導入は公式サイトから`,
    ];

    let index = 0;

    setInterval(() => {
        const status = activities[index % activities.length]();
        client.user.setPresence({
            activities: [{ name: status, type: 0 }],
            status: "online",
        });
        index++;
    }, 30000); // 5秒ごとに変更
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
    // スラッシュコマンドの処理
    if (interaction.isChatInputCommand()) {
        const command = interaction.client.commands.get(
            interaction.commandName,
        );
        if (!command) {
            console.error(
                `${interaction.commandName} に一致するコマンドが見つかんなかっ ��よ。`,
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
                ephemeral: true,
            });
            return;
        }

        // クールダウンを更新
        userCooldowns[commandName] = now;
        commandCooldowns.set(userId, userCooldowns);

        // コマンド実行
        try {
            await command.execute(interaction);
        } catch (error) {
            console.error(error);
            const replyContent = {
                content: "コマンド実行してるときにエラー出たんだってさ。",
                ephemeral: true,
            };
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(replyContent);
            } else {
                await interaction.reply(replyContent);
            }
        }
    }

    // ボタンやセレクトメニューの処理（別分岐）
    else if (interaction.isButton() || interaction.isStringSelectMenu()) {
        if (
            interaction.customId === "start_auth" ||
            interaction.customId === "auth_answer"
        ) {
            await authPanel.handleAuthInteraction(interaction);
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

// ロール作成監視
client.on(Events.GuildRoleCreate, async (role) => {
    // 監査ログから作成者を取得
    try {
        const auditLogs = await role.guild.fetchAuditLogs({
            type: 30, // ROLE_CREATE
            limit: 1,
        });

        const logEntry = auditLogs.entries.first();
        if (logEntry && logEntry.executor && logEntry.executor.bot) {
            await checkForNukeBot(role.guild, logEntry.executor, "role");
        }
    } catch (error) {
        console.error("ロール作成監視中にエラーが発生しました:", error);
    }
});

// ロール削除監視
client.on(Events.GuildRoleDelete, async (role) => {
    try {
        const auditLogs = await role.guild.fetchAuditLogs({
            type: 32, // ROLE_DELETE
            limit: 1,
        });

        const logEntry = auditLogs.entries.first();
        if (logEntry && logEntry.executor && logEntry.executor.bot) {
            await checkForNukeBot(role.guild, logEntry.executor, "role");
        }
    } catch (error) {
        console.error("ロール削除監視中にエラーが発生しました:", error);
    }
});

client.on(Events.ChannelCreate, async (channel) => {
    // NukeBot検知のためのチャンネル作成監視
    try {
        const auditLogs = await channel.guild.fetchAuditLogs({
            type: 10, // CHANNEL_CREATE
            limit: 1,
        });

        const logEntry = auditLogs.entries.first();
        if (logEntry && logEntry.executor && logEntry.executor.bot) {
            await checkForNukeBot(channel.guild, logEntry.executor, "channel");
        }
    } catch (error) {
        console.error("チャンネル作成監視中にエラーが発生しました:", error);
    }

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
                    `新しいチャンネル ${channel.name} にRaidGuard_AuAuロールの権限を  �定しました`,
                );
            } catch (error) {
                console.error(
                    `チャンネル ${channel.name} のRaidGuard_AuAu権限設定に失敗:`,
                    error,
                );
            }
        }

        const appRestrictRole = channel.guild.roles.cache.find(
            (role) => role.name === "AppRestrict_AuAu",
        );

        if (appRestrictRole) {
            try {
                await channel.permissionOverwrites.create(appRestrictRole, {
                    UseApplicationCommands: false,
                });
                console.log(
                    `新しいチャンネル ${channel.name} にAppRestrict_AuAuロールの権限を設定しました`,
                );
            } catch (error) {
                console.error(
                    `チャンネル ${channel.name} のAppRestrict_AuAu権限設定に失敗:`,
                    error,
                );
            }
        }
    }
});

// チャンネル削除監視
client.on(Events.ChannelDelete, async (channel) => {
    try {
        const auditLogs = await channel.guild.fetchAuditLogs({
            type: 12, // CHANNEL_DELETE
            limit: 1,
        });

        const logEntry = auditLogs.entries.first();
        if (logEntry && logEntry.executor && logEntry.executor.bot) {
            await checkForNukeBot(channel.guild, logEntry.executor, "channel");
        }
    } catch (error) {
        console.error("チャンネル削除監視中にエラーが発生しました:", error);
    }
});

client.on(Events.ThreadCreate, async (thread) => {
    if (!thread.ownerId) return; // システム作成スレッドは無視

    const member = thread.guild.members.cache.get(thread.ownerId);
    if (!member || member.user.bot) return; // Botは無視

    // 除外ロールチェック
    const guildId = thread.guild.id;
    const exclusion = global.exclusionRoles?.get(guildId);

    if (exclusion && exclusion.threadSpam?.size > 0) {
        const hasExclusionRole = member.roles.cache.some((role) =>
            exclusion.threadSpam.has(role.id),
        );
        if (hasExclusionRole) {
            console.log(
                `スレッドスパム検知をスキップ: ${member.user.username} (除外ロール所持)`,
            );
            return;
        }
    }

    await checkThreadSpam(member, thread.guild);
});

// スレッド更新監視 - 新規追加
client.on(Events.ThreadUpdate, async (oldThread, newThread) => {
    if (!newThread.ownerId) return;

    const member = newThread.guild.members.cache.get(newThread.ownerId);
    if (!member || member.user.bot) return;

    // タイトルや設定が変更された場合のみ検知
    if (
        oldThread.name !== newThread.name ||
        oldThread.archived !== newThread.archived ||
        oldThread.locked !== newThread.locked
    ) {
        // 除外ロールチェック
        const guildId = newThread.guild.id;
        const exclusion = global.exclusionRoles?.get(guildId);

        if (exclusion && exclusion.threadSpam?.size > 0) {
            const hasExclusionRole = member.roles.cache.some((role) =>
                exclusion.threadSpam.has(role.id),
            );
            if (hasExclusionRole) {
                console.log(
                    `スレッドスパム検知をスキップ: ${member.user.username} (除外ロール所持)`,
                );
                return;
            }
        }

        await checkThreadSpam(member, newThread.guild);
    }
});

// ファイルの上部に追加
const { GoogleGenerativeAI } = require("@google/generative-ai");
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

client.on("messageCreate", async (msg) => {
    if (msg.author.bot) return;

    // ファクトチェック処理（スパム検知より前に実行）
    if (msg.reference && msg.mentions.has(client.user)) {
        if (
            msg.content.includes("ファクトチェック") ||
            msg.content.includes("factcheck")
        ) {
            try {
                // リプライされたメッセージを取得
                const repliedMessage = await msg.channel.messages.fetch(
                    msg.reference.messageId,
                );

                if (
                    !repliedMessage.content ||
                    repliedMessage.content.trim().length === 0
                ) {
                    await msg.reply(
                        "ファクトチェックできるテキストがありません。",
                    );
                    return;
                }

                // 処理中メッセージを送信
                const processingMessage =
                    await msg.reply("🔎 ファクトチェック中...");

                const model = genAI.getGenerativeModel({
                    model: "gemini-1.5-flash",
                });
                const result = await model.generateContent([
                    "以下の文が事実かどうかファクトチェックしてください。簡潔に解説も添えてください。",
                    repliedMessage.content,
                ]);
                const response = await result.response;
                const text = response.text();

                // 処理中メッセージを編集
                await processingMessage.edit(
                    `🔎 **ファクトチェック結果:**\n${text}`,
                );

                return; // ファクトチェック処理後はここで終了
            } catch (error) {
                console.error("FactCheck Error:", error);
                if (error.code === 10008) {
                    await msg.reply(
                        "リプライされたメッセージが見つかりません。メッセージが削除されているか、古すぎる可能性があります。",
                    );
                } else {
                    await msg.reply(
                        "エラーが発生しました。もう一度お試しください。",
                    );
                }
                return;
            }
        }
    }

    // 除外ロールチェック（スパム検知回避）
    const guildId = msg.guild?.id;
    const exclusion = global.exclusionRoles?.get(guildId);

    if (exclusion && exclusion.spam?.size > 0) {
        const member = msg.guild.members.cache.get(msg.author.id);
        if (member) {
            const hasExclusionRole = member.roles.cache.some((role) =>
                exclusion.spam.has(role.id),
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

    // スパム検知処理
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

    // 通常メッセージ処理
    await processNonSpamMessage(msg);
});

// アプリケーション使用制限のための設定
let appRestrictionEnabled = false; // 全体的なアプリケーション制限フラグ
global.appRestrictionEnabled = false;

// アプリケーション使用検知とロール付与機能
client.on(Events.InteractionCreate, async (interaction) => {
    // アプリケーションコマンドの使用を検知
    if (interaction.isCommand()) {
        const user = interaction.user;
        const guild = interaction.guild;

        if (!guild) return; // DMでは処理しない

        // 自分のBotのコマンドは制限しない
        if (interaction.applicationId === client.user.id) {
            return;
        }

        // 全体的なアプリケーション制限が有効な場合
        if (global.appRestrictionEnabled) {
            try {
                console.log(
                    `アプリケーション使用制限: ${user.username} - コマンド: ${interaction.commandName || "unknown"}`,
                );

                // AppRestrict_AuAuロールを取得または作成
                let restrictRole = guild.roles.cache.find(
                    (role) => role.name === "AppRestrict_AuAu",
                );

                if (!restrictRole) {
                    restrictRole = await guild.roles.create({
                        name: "AppRestrict_AuAu",
                        color: "#FFA500",
                        reason: "アプリケーション使用制限ロール",
                    });
                    console.log(`AppRestrict_AuAuロールを作成しました`);

                    // 全チャンネルでAppRestrict_AuAuロールのアプリケーション使用を制限
                    guild.channels.cache.forEach(async (channel) => {
                        if (
                            channel.type === ChannelType.GuildText ||
                            channel.type === ChannelType.GuildVoice
                        ) {
                            try {
                                await channel.permissionOverwrites.create(
                                    restrictRole,
                                    {
                                        UseApplicationCommands: false,
                                        UseSlashCommands: false,
                                    },
                                );
                            } catch (error) {
                                console.error(
                                    `チャンネル ${channel.name} のアプリケーション制限権限設定に失敗:`,
                                    error,
                                );
                            }
                        }
                    });
                }

                const member = guild.members.cache.get(user.id);
                if (member && !member.roles.cache.has(restrictRole.id)) {
                    await member.roles.add(restrictRole);
                    console.log(
                        `${user.username} にAppRestrict_AuAuロールを付与しました`,
                    );

                    // ログチャンネルに通知
                    let logChannel = guild.channels.cache.find(
                        (channel) =>
                            channel.name === "auau-log" &&
                            channel.type === ChannelType.GuildText,
                    );

                    if (logChannel) {
                        await logChannel.send(
                            `🚨 **アプリケーション使用制限**\n` +
                                `ユーザー: ${user.username} (${user.id})\n` +
                                `コマンド: ${interaction.commandName || "unknown"}\n` +
                                `アプリケーション使用制限が有効なため、AppRestrict_AuAuロールを付与しました。`,
                        );
                    }
                }

                // 元のインタラクションにエラーメッセージを送信
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content:
                            "⚠️ 現在、外部アプリケーションの使用が制限されています。管理者にお問い合わせください。",
                        ephemeral: true,
                    });
                }
                return;
            } catch (error) {
                console.error(
                    "アプリケーション制限ロール付与中にエラーが発生しました:",
                    error,
                );
            }
        }

        // コマンドの内容をチェック
        let contentToCheck = "";

        // スラッシュコマンドの場合
        if (interaction.commandName) {
            contentToCheck += interaction.commandName + " ";
        }

        // オプションがある場合
        if (interaction.options && interaction.options.data) {
            for (const option of interaction.options.data) {
                if (option.value && typeof option.value === "string") {
                    contentToCheck += option.value + " ";
                }
            }
        }

        // 悪意あるワードをチェック
        const containsMaliciousWord = MALICIOUS_APP_WORDS.some((word) =>
            contentToCheck.toLowerCase().includes(word.toLowerCase()),
        );

        if (containsMaliciousWord) {
            try {
                console.log(
                    `アプリケーション使用時の悪意あるワード検知: ${user.username} - "${contentToCheck}"`,
                );

                // AppRestrict_AuAuロールを取得または作成
                let restrictRole = guild.roles.cache.find(
                    (role) => role.name === "AppRestrict_AuAu",
                );

                if (!restrictRole) {
                    restrictRole = await guild.roles.create({
                        name: "AppRestrict_AuAu",
                        color: "#FFA500",
                        reason: "アプリケーション使用制限ロール",
                    });
                    console.log(`AppRestrict_AuAuロールを作成しました`);
                }

                const member = guild.members.cache.get(user.id);
                if (member && !member.roles.cache.has(restrictRole.id)) {
                    await member.roles.add(restrictRole);
                    console.log(
                        `${user.username} にAppRestrict_AuAuロールを付与しました`,
                    );

                    // ログチャンネルに通知
                    let logChannel = guild.channels.cache.find(
                        (channel) =>
                            channel.name === "auau-log" &&
                            channel.type === ChannelType.GuildText,
                    );

                    if (logChannel) {
                        await logChannel.send(
                            `🚨 **アプリケーション使用時の悪意あるワード検知**\n` +
                                `ユーザー: ${user.username} (${user.id})\n` +
                                `検知内容: "${contentToCheck}"\n` +
                                `AppRestrict_AuAuロールを付与しました。`,
                        );
                    }
                }

                // 元のインタラクションにエラーメッセージを送信
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content:
                            "⚠️ 不適切な内容が検出されました。アプリケーション使用制限ロールが付与されました。",
                        ephemeral: true,
                    });
                }
            } catch (error) {
                console.error(
                    "アプリケーション制限ロール付与中にエラーが発生しました:",
                    error,
                );
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

    const userId = msg.author.id;
    const now = Date.now();

    // 語録反応のクールダウン処理
    if (!gorokuCooldowns.has(userId)) {
        gorokuCooldowns.set(userId, 0);
    }
    const lastGorokuTime = gorokuCooldowns.get(userId);
    if (now - lastGorokuTime < GOROKU_COOLDOWN_TIME) return;

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
        const responses = [
            ":warning: 淫夢発言を検知しました！！ :warning:",
            "あっ、今ホモ発言したよね？",
            "やりますねぇ！",
            "なんで淫夢語録使ったんですか？（正論）",
            "淫夢発言は草",
        ];
        const randomResponse =
            responses[Math.floor(Math.random() * responses.length)];
        await msg.reply(randomResponse);
        gorokuCooldowns.set(userId, now);
    } else if (containsAnyWord(soudayo)) {
        await msg.reply("そうだよ(便乗)");
        gorokuCooldowns.set(userId, now);
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
        await msg.reply("https://i.imgur.com/kSCMoPg.jpeg");
        gorokuCooldowns.set(userId, now);
    } else if (containsAnyWord(matakayo)) {
        await msg.reply(
            "なんだよもおおおお、またかよおおおおおおおおおおお！！！！\nhttps://www.youtube.com/watch?v=KXOXuRC15QQ",
        );
        gorokuCooldowns.set(userId, now);
    }
}

if (!PORT) {
    console.error("[ERROR] RenderのPORTが定義されていません！");
    process.exit(1);
}

app.get("/", (req, res) => {
    res.send("AuAuBot Web Server 起動中！");
});

client
    .login(token)
    .then(() => {
        if (!PORT) {
            console.error("[ERROR] RenderのPORTが定義されていません！");
            process.exit(1);
        }

        console.log("[CHECK] app.listen 実行直前");

        app.listen(PORT, () => {
            console.log(`[CHECK] ✅ HTTP server running on port ${PORT}`);
        });
    })
    .catch((error) => {
        console.error("[ERROR] Discordクライアントのログインに失敗:", error);
        process.exit(1);
    });
