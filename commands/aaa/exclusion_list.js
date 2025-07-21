const {
    SlashCommandBuilder,
    PermissionFlagsBits,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require("discord.js");
const fs = require("node:fs");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("exclusion_list")
        .setDescription("検知を回避するロールを設定します")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        try {
            const guild = interaction.guild;

            const existingData = global.exclusionRoles || new Map();
            global.exclusionRoles = existingData;

            const current = existingData.get(guild.id) || {
                spam: new Set(),
                profanity: new Set(),
                inmu: new Set(),
                link: new Set(),
                threadSpam: new Set(),  // 新規追加
                profanityDetection: new Set()  // 新規追加（暴言検知用）
            };

            const roles = guild.roles.cache
                .filter((role) => role.name !== "@everyone" && !role.managed)
                .sort((a, b) => b.position - a.position);

            if (roles.size === 0) {
                await interaction.editReply("設定可能なロールがありません。");
                return;
            }

            const makeOptionsForCategory = (set, label) =>
                roles.map((role) => {
                    const included = set.has(role.id);
                    return {
                        label: `[${label}] ${role.name}`,
                        description: included ? "現在: 回避" : "現在: 対象",
                        value: `${label}:${role.id}`,
                        emoji: included ? "✅" : "❌",
                    };
                });

            const allOptions = [
                ...makeOptionsForCategory(current.spam, "spam"),
                ...makeOptionsForCategory(current.profanity, "profanity"), 
                ...makeOptionsForCategory(current.inmu, "inmu"),
                ...makeOptionsForCategory(current.link, "link"),
                ...makeOptionsForCategory(current.threadSpam, "threadSpam"),  // 新規追加
                ...makeOptionsForCategory(current.profanityDetection, "profanityDetection"),  // 新規追加
            ];

            const itemsPerPage = 25;
            const totalPages = Math.ceil(allOptions.length / itemsPerPage);
            let currentPage = 0;

            const createMenuForPage = (page) => {
                const pageOptions = allOptions.slice(
                    page * itemsPerPage,
                    (page + 1) * itemsPerPage,
                );

                const menu = new StringSelectMenuBuilder()
                    .setCustomId("multi_exclusion_select")
                    .setPlaceholder(`ロールを選択 (${page + 1}/${totalPages})`)
                    .addOptions(
                        pageOptions.map((opt) =>
                            new StringSelectMenuOptionBuilder()
                                .setLabel(opt.label)
                                .setDescription(opt.description)
                                .setValue(opt.value)
                                .setEmoji(opt.emoji),
                        ),
                    )
                    .setMaxValues(pageOptions.length);

                return menu;
            };

            const createButtons = (page) => {
                const buttons = [];

                if (page > 0) {
                    buttons.push(
                        new ButtonBuilder()
                            .setCustomId("prev_page")
                            .setLabel("◀ 前のページ")
                            .setStyle(ButtonStyle.Secondary),
                    );
                }

                buttons.push(
                    new ButtonBuilder()
                        .setCustomId("page_info")
                        .setLabel(`${page + 1}/${totalPages}`)
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(true),
                );

                if (page < totalPages - 1) {
                    buttons.push(
                        new ButtonBuilder()
                            .setCustomId("next_page")
                            .setLabel("次のページ ▶")
                            .setStyle(ButtonStyle.Secondary),
                    );
                }

                return buttons;
            };

            const updateMessage = async (page, targetInteraction) => {
                const menu = createMenuForPage(page);
                const buttons = createButtons(page);

                const components = [new ActionRowBuilder().addComponents(menu)];
                if (totalPages > 1) {
                    components.push(
                        new ActionRowBuilder().addComponents(buttons),
                    );
                }

                const content = `以下の検知をロールごとに回避設定できます（✅ = 回避中）\n\n現在のページ: ${page + 1}/${totalPages}`;

                if (targetInteraction.deferred || targetInteraction.replied) {
                    await targetInteraction.editReply({ content, components });
                } else {
                    await targetInteraction.update({ content, components });
                }
            };

            await updateMessage(currentPage, interaction);

            const response = await interaction.fetchReply();
            const collector = response.createMessageComponentCollector({
                time: 300000,
            });

            collector.on("collect", async (componentInteraction) => {
                if (componentInteraction.user.id !== interaction.user.id) {
                    await componentInteraction.reply({
                        content: "このメニューを操作する権限がありません。",
                        ephemeral: true,
                    });
                    return;
                }

                if (componentInteraction.isButton()) {
                    if (componentInteraction.customId === "prev_page") {
                        currentPage = Math.max(0, currentPage - 1);
                        await updateMessage(currentPage, componentInteraction);
                    } else if (componentInteraction.customId === "next_page") {
                        currentPage = Math.min(totalPages - 1, currentPage + 1);
                        await updateMessage(currentPage, componentInteraction);
                    }
                } else if (componentInteraction.isStringSelectMenu()) {
                    for (const value of componentInteraction.values) {
                        const [type, roleId] = value.split(":");
                        const set = current[type];
                        if (!set) continue;
                        if (set.has(roleId)) set.delete(roleId);
                        else set.add(roleId);
                    }

                    existingData.set(guild.id, current);
                    global.exclusionRoles = existingData;

                    // スパム除外だけは専用Mapにも同期
                    if (!global.spamExclusionRoles)
                        global.spamExclusionRoles = new Map();
                    global.spamExclusionRoles.set(guild.id, current.spam);

                    const dataToSave = {};
                    for (const [guildId, sets] of existingData.entries()) {
                        dataToSave[guildId] = {
                            spam: Array.from(sets.spam),
                            profanity: Array.from(sets.profanity),
                            inmu: Array.from(sets.inmu), 
                            link: Array.from(sets.link),
                            threadSpam: Array.from(sets.threadSpam),  // 新規追加
                            profanityDetection: Array.from(sets.profanityDetection),  // 新規追加
                        };
                    }
                    fs.writeFileSync(
                        "./exclusion_roles.json",
                        JSON.stringify(dataToSave, null, 2),
                    );

                    await componentInteraction.reply({
                        content: "✅ 設定を更新しました！",
                        ephemeral: true,
                    });

                    await updateMessage(currentPage, interaction);
                }
            });

            collector.on("end", async () => {
                await interaction.editReply({
                    content: "⏱️ メニューの有効期限が切れました。",
                    components: [],
                });
            });
        } catch (error) {
            console.error("エラー:", error);
            await interaction.editReply(
                "❌ コマンド実行中にエラーが発生しました。",
            );
        }
    },
};
