const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("config")
        .setDescription("スレッドスパム検知の設定を変更します")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
        .addSubcommand((subcommand) =>
            subcommand
                .setName("thread-spam")
                .setDescription("スレッドスパム検知の設定")
                .addIntegerOption((option) =>
                    option
                        .setName("threshold")
                        .setDescription("検知する操作回数 (1-10)")
                        .setRequired(true)
                        .setMinValue(1)
                        .setMaxValue(10),
                )
                .addIntegerOption((option) =>
                    option
                        .setName("time-window")
                        .setDescription("検知する時間枠（秒）(10-300)")
                        .setRequired(true)
                        .setMinValue(10)
                        .setMaxValue(300),
                )
                .addIntegerOption((option) =>
                    option
                        .setName("timeout-duration")
                        .setDescription("タイムアウト時間（分）(1-1440)")
                        .setRequired(true)
                        .setMinValue(1)
                        .setMaxValue(1440),
                ),
        )
        .addSubcommand((subcommand) =>
            subcommand.setName("view").setDescription("現在の設定を表示します"),
        ),

    async execute(interaction) {
        const guildId = interaction.guild.id;

        if (interaction.options.getSubcommand() === "view") {
            const settings = global.threadSpamSettings.get(guildId) || {
                threshold: 3,
                timeWindow: 30000,
                timeoutDuration: 600000,
            };

            const embed = {
                title: "🔧 スレッドスパム検知設定",
                fields: [
                    {
                        name: "検知操作回数",
                        value: `${settings.threshold}回`,
                        inline: true,
                    },
                    {
                        name: "検知時間枠",
                        value: `${Math.floor(settings.timeWindow / 1000)}秒`,
                        inline: true,
                    },
                    {
                        name: "タイムアウト時間",
                        value: `${Math.ceil(settings.timeoutDuration / 60000)}分`,
                        inline: true,
                    },
                ],
                color: 0x0099ff,
                footer: {
                    text: "設定を変更するには /config thread-spam を使用してください",
                },
            };

            await interaction.reply({ embeds: [embed], ephemeral: true });
        } else if (interaction.options.getSubcommand() === "thread-spam") {
            const threshold = interaction.options.getInteger("threshold");
            const timeWindow =
                interaction.options.getInteger("time-window") * 1000; // 秒からミリ秒に変換
            const timeoutDuration =
                interaction.options.getInteger("timeout-duration") * 60000; // 分からミリ秒に変換

            // 設定を保存
            if (!global.threadSpamSettings) {
                global.threadSpamSettings = new Map();
            }

            global.threadSpamSettings.set(guildId, {
                threshold,
                timeWindow,
                timeoutDuration,
            });

            const embed = {
                title: "✅ スレッドスパム検知設定を更新しました",
                fields: [
                    {
                        name: "検知操作回数",
                        value: `${threshold}回`,
                        inline: true,
                    },
                    {
                        name: "検知時間枠",
                        value: `${Math.floor(timeWindow / 1000)}秒`,
                        inline: true,
                    },
                    {
                        name: "タイムアウト時間",
                        value: `${Math.ceil(timeoutDuration / 60000)}分`,
                        inline: true,
                    },
                ],
                color: 0x00ff00,
            };

            await interaction.reply({ embeds: [embed], ephemeral: true });
            console.log(
                `スレッドスパム設定更新 - Guild: ${guildId}, 操作回数: ${threshold}, 時間枠: ${Math.floor(timeWindow / 1000)}秒, タイムアウト: ${Math.ceil(timeoutDuration / 60000)}分`,
            );
        }
    },
};
