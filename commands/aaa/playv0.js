const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
} = require("@discordjs/voice");
const youtubedl = require("youtube-dl-exec");

// グローバルな音楽キューとプレイヤー管理
if (!global.musicQueues) {
  global.musicQueues = new Map();
}
if (!global.musicPlayers) {
  global.musicPlayers = new Map();
}
if (!global.musicConnections) {
  global.musicConnections = new Map();
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("play-v0")
    .setDescription("YouTubeやニコニコ動画、TikTokなどの音楽を再生するよ～")
    .addStringOption((option) =>
      option
        .setName("url")
        .setDescription("動画のURL（YouTube、ニコニコ動画、TikTokなど）")
        .setRequired(true),
    ),

  async execute(interaction) {
    try {
      console.log("コマンド実行開始");

      // ユーザーがボイスチャンネルに接続しているかチェック
      let voiceChannel = null;

      if (interaction.member?.voice?.channel) {
        voiceChannel = interaction.member.voice.channel;
      } else {
        const member = await interaction.guild.members.fetch(
          interaction.user.id,
        );
        voiceChannel = member.voice.channel;
      }

      if (!voiceChannel) {
        return await interaction.reply(
          "ボイスチャンネルに接続してから使ってね！",
        );
      }

      // ボットの権限をチェック
      const permissions = voiceChannel.permissionsFor(interaction.client.user);
      if (!permissions.has("Connect") || !permissions.has("Speak")) {
        return await interaction.reply(
          "ボイスチャンネルに接続または発言する権限がありません！",
        );
      }

      const url = interaction.options.getString("url");
      const guildId = interaction.guild.id;

      // 対応サイトの検証
      const supportedSites = [
        "youtube.com",
        "youtu.be",
        "m.youtube.com",
        "nicovideo.jp",
        "nico.ms",
        "sp.nicovideo.jp",
        "tiktok.com",
        "vt.tiktok.com",
        "soundcloud.com",
        "m.soundcloud.com",
        "bilibili.com",
        "b23.tv",
      ];

      const isSupported = supportedSites.some((site) => url.includes(site));

      if (!isSupported) {
        return await interaction.reply(
          "対応していないサイトです。YouTube、ニコニコ動画、TikTok、SoundCloudなどのURLを入力してね！",
        );
      }

      await interaction.reply("音楽を準備中...🎵");

      // TikTokかどうかを判定
      const isTikTok =
        url.includes("tiktok.com") || url.includes("vt.tiktok.com");

      // TikTokの場合は特別な処理
      if (isTikTok) {
        try {
          // TikTokの動画情報取得（より短いタイムアウト）
          const info = await Promise.race([
            youtubedl(url, {
              dumpSingleJson: true,
              noWarnings: true,
              noCallHome: true,
              noCheckCertificate: true,
              preferFreeFormats: true,
              noPlaylist: true,
              ignoreErrors: true,
              // TikTok用の追加オプション
              addHeader: [
                "User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
              ],
              referer: "https://www.tiktok.com/",
            }),
            new Promise((_, reject) =>
              setTimeout(
                () =>
                  reject(
                    new Error("TikTok動画情報の取得がタイムアウトしました"),
                  ),
                15000, // TikTokは15秒でタイムアウト
              ),
            ),
          ]);

          // TikTok動画の検証
          if (!info || (!info.formats && !info.url)) {
            throw new Error("TikTok動画の情報を取得できませんでした");
          }

          const title =
            info.title || info.description?.slice(0, 100) || "TikTok動画";
          const thumbnail = info.thumbnail || info.thumbnails?.[0]?.url || null;
          const duration = info.duration ? Math.floor(info.duration) : null;
          const uploader =
            info.uploader || info.uploader_id || "TikTokユーザー";

          console.log("TikTok動画情報取得完了:", title);

          const songInfo = {
            url,
            title,
            thumbnail,
            duration,
            uploader,
            requester: interaction.user.id,
            requesterName: interaction.user.displayName,
            isTikTok: true,
          };

          await this.addToQueueAndPlay(interaction, voiceChannel, songInfo);
        } catch (tiktokError) {
          console.error("TikTok処理エラー:", tiktokError);

          // TikTokエラーの詳細な処理
          let errorMessage = "TikTok動画の再生に失敗しました。";

          if (tiktokError.message.includes("タイムアウト")) {
            errorMessage =
              "TikTok動画の読み込みがタイムアウトしました。動画が長すぎるか、サーバーが応答しない可能性があります。";
          } else if (
            tiktokError.message.includes("Private") ||
            tiktokError.message.includes("unavailable")
          ) {
            errorMessage =
              "この動画は非公開か削除されているため再生できません。";
          } else if (
            tiktokError.message.includes("region") ||
            tiktokError.message.includes("geo")
          ) {
            errorMessage = "地域制限により、この動画は再生できません。";
          } else {
            errorMessage =
              "TikTok動画の処理中にエラーが発生しました。他のプラットフォームの動画をお試しください。";
          }

          return await interaction.editReply(errorMessage);
        }
      } else {
        // 通常の動画情報を取得（YouTube、ニコニコ動画など）
        console.log("動画情報を取得中...");
        const info = await Promise.race([
          youtubedl(url, {
            dumpSingleJson: true,
            noWarnings: true,
            noCallHome: true,
            noCheckCertificate: true,
            preferFreeFormats: true,
            youtubeSkipDashManifest: true,
            noPlaylist: true,
            ignoreErrors: true,
          }),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("動画情報の取得がタイムアウトしました")),
              30000,
            ),
          ),
        ]);

        const title = info.title || "タイトル不明";
        const thumbnail = info.thumbnail || info.thumbnails?.[0]?.url || null;
        const duration = info.duration ? Math.floor(info.duration) : null;
        const uploader = info.uploader || info.channel || "投稿者不明";

        console.log("動画情報取得完了:", title);

        const songInfo = {
          url,
          title,
          thumbnail,
          duration,
          uploader,
          requester: interaction.user.id,
          requesterName: interaction.user.displayName,
          isTikTok: false,
        };

        await this.addToQueueAndPlay(interaction, voiceChannel, songInfo);
      }
    } catch (error) {
      console.error("音楽再生エラー:", error);

      let errorMessage = "音楽の再生中にエラーが発生しました。";

      if (error.message.includes("タイムアウト")) {
        errorMessage =
          "動画の読み込みに時間がかかりすぎています。別のURLを試してください。";
      } else if (error.message.includes("Video unavailable")) {
        errorMessage = "この動画は利用できません。別のURLを試してください。";
      } else if (error.message.includes("Private video")) {
        errorMessage = "プライベート動画は再生できません。";
      } else if (error.message.includes("Requested format is not available")) {
        errorMessage = "このフォーマットは利用できません。";
      }

      try {
        await interaction.editReply(errorMessage);
      } catch (replyError) {
        console.error("リプライエラー:", replyError);
      }
    }
  },

  async addToQueueAndPlay(interaction, voiceChannel, songInfo) {
    const guildId = interaction.guild.id;

    // キューの初期化
    if (!global.musicQueues.has(guildId)) {
      global.musicQueues.set(guildId, []);
    }

    const queue = global.musicQueues.get(guildId);
    const isPlaying =
      global.musicPlayers.has(guildId) &&
      global.musicPlayers.get(guildId).state.status ===
        AudioPlayerStatus.Playing;

    // キューに追加
    queue.push(songInfo);

    if (isPlaying) {
      // 既に再生中の場合はキューに追加のみ
      const embed = new EmbedBuilder()
        .setTitle("🎵 キューに追加されました")
        .setDescription(`**[${songInfo.title}](${songInfo.url})**`)
        .setColor(0x0099ff)
        .addFields(
          { name: "投稿者", value: songInfo.uploader, inline: true },
          {
            name: "リクエスト者",
            value: `<@${interaction.user.id}>`,
            inline: true,
          },
          { name: "キュー位置", value: `${queue.length}番目`, inline: true },
        )
        .setFooter({
          text: `キューに${queue.length}曲待機中`,
        });

      if (songInfo.thumbnail) {
        embed.setThumbnail(songInfo.thumbnail);
      }

      if (songInfo.duration) {
        const minutes = Math.floor(songInfo.duration / 60);
        const seconds = songInfo.duration % 60;
        embed.addFields({
          name: "再生時間",
          value: `${minutes}:${seconds.toString().padStart(2, "0")}`,
          inline: true,
        });
      }

      await interaction.editReply({ content: null, embeds: [embed] });
    } else {
      // 初回再生または再生停止中の場合
      await this.playNextSong(interaction, voiceChannel);
    }
  },

  async playNextSong(interaction, voiceChannel) {
    const guildId = interaction.guild.id;
    const queue = global.musicQueues.get(guildId);

    if (!queue || queue.length === 0) {
      // キューが空の場合
      return;
    }

    const songInfo = queue.shift(); // キューから最初の曲を取得

    try {
      // ボイスチャンネルに接続
      let connection = global.musicConnections.get(guildId);
      if (!connection) {
        connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: interaction.guild.id,
          adapterCreator: interaction.guild.voiceAdapterCreator,
        });
        global.musicConnections.set(guildId, connection);
      }

      // 音声ストリームを作成
      let streamOptions;
      let stream;

      if (songInfo.isTikTok) {
        // TikTok用の特別なストリーミング設定
        streamOptions = {
          output: "-",
          format: "best[height<=720][ext=mp4]/best[ext=mp4]/best",
          noWarnings: true,
          noCallHome: true,
          noCheckCertificate: true,
          noPlaylist: true,
          ignoreErrors: true,
          extractFlat: false,
          writeInfoJson: false,
          // TikTok用追加設定
          addHeader: [
            "User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          ],
          referer: "https://www.tiktok.com/",
          retries: 3,
          proxy: "http://47.74.46.81:11310",
        };

        // TikTokストリーミングをタイムアウトで制限
        const streamPromise = youtubedl.exec(songInfo.url, streamOptions);
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("TikTokストリーム作成タイムアウト")),
            20000,
          ),
        );

        stream = await Promise.race([streamPromise, timeoutPromise]);
      } else {
        streamOptions = {
          output: "-",
          format: "bestaudio/best",
          audioFormat: "wav",
          audioQuality: "0",
          noWarnings: true,
          noCallHome: true,
          noCheckCertificate: true,
          noPlaylist: true,
          preferFreeFormats: true,
          ignoreErrors: true,
          proxy: "http://47.74.46.81:11310",
        };

        stream = youtubedl.exec(songInfo.url, streamOptions);
      }

      // オーディオリソースを作成
      const resource = createAudioResource(stream.stdout, {
        inputType: "arbitrary",
        inlineVolume: false,
        metadata: {
          title: songInfo.title,
          songInfo: songInfo,
        },
      });

      // オーディオプレイヤーを作成または取得
      let player = global.musicPlayers.get(guildId);
      if (!player) {
        player = createAudioPlayer();
        global.musicPlayers.set(guildId, player);

        // プレイヤーのイベントリスナー
        player.on(AudioPlayerStatus.Playing, () => {
          console.log("音楽を再生中...");
        });

        player.on(AudioPlayerStatus.Idle, () => {
          console.log("音楽の再生が終了しました");
          // 次の曲を再生
          setTimeout(() => {
            this.playNextSong(interaction, voiceChannel);
          }, 1000);
        });

        player.on("error", (error) => {
          console.error("プレイヤーエラー:", error);
          // エラー時は次の曲を再生を試行
          setTimeout(() => {
            const currentQueue = global.musicQueues.get(guildId);
            if (currentQueue && currentQueue.length > 0) {
              this.playNextSong(interaction, voiceChannel);
            }
          }, 2000);
        });
      }

      // 接続エラーハンドリング
      connection.on(VoiceConnectionStatus.Disconnected, () => {
        console.log("ボイスチャンネルから切断されました");
      });

      connection.on("error", (error) => {
        console.error("接続エラー:", error);
      });

      // 接続にプレイヤーを設定
      connection.subscribe(player);

      // 現在再生中の曲情報を保存
      if (!global.currentSongs) {
        global.currentSongs = new Map();
      }
      global.currentSongs.set(guildId, songInfo);

      // 音楽を再生
      player.play(resource);

      // 再生開始メッセージを送信
      const embed = new EmbedBuilder()
        .setTitle("🎵 現在再生中")
        .setDescription(`**[${songInfo.title}](${songInfo.url})**`)
        .setColor(0x00ff00)
        .addFields(
          { name: "投稿者", value: songInfo.uploader, inline: true },
          {
            name: "リクエスト者",
            value: `<@${songInfo.requester}>`,
            inline: true,
          },
          { name: "チャンネル", value: `<#${voiceChannel.id}>`, inline: true },
        )
        .setFooter({
          text: `キューに${queue.length}曲待機中 | 音楽を停止するには /leave コマンドを使用してください`,
        });

      if (songInfo.thumbnail) {
        embed.setThumbnail(songInfo.thumbnail);
      }

      if (songInfo.duration) {
        const minutes = Math.floor(songInfo.duration / 60);
        const seconds = songInfo.duration % 60;
        embed.addFields({
          name: "再生時間",
          value: `${minutes}:${seconds.toString().padStart(2, "0")}`,
          inline: true,
        });
      }

      // TikTokの場合は特別な注意書きを追加
      if (songInfo.isTikTok) {
        embed.setFooter({
          text: `キューに${queue.length}曲待機中 | TikTok動画は音質が制限される場合があります`,
        });
      }

      await interaction.editReply({ content: null, embeds: [embed] });
    } catch (error) {
      console.error("再生エラー:", error);

      // エラーメッセージを詳細に分類
      let errorMessage = "再生中にエラーが発生しました。";

      if (songInfo.isTikTok) {
        errorMessage = `TikTok動画「${songInfo.title}」の再生に失敗しました。次の曲をスキップします。`;
      } else {
        errorMessage = `「${songInfo.title}」の再生に失敗しました。次の曲をスキップします。`;
      }

      // エラーメッセージを送信（可能であれば）
      try {
        const errorEmbed = new EmbedBuilder()
          .setTitle("⚠️ 再生エラー")
          .setDescription(errorMessage)
          .setColor(0xff0000);

        await interaction.followUp({ embeds: [errorEmbed], ephemeral: true });
      } catch (followUpError) {
        console.error("フォローアップエラー:", followUpError);
      }

      // エラー時は次の曲を再生
      setTimeout(() => {
        const currentQueue = global.musicQueues.get(guildId);
        if (currentQueue && currentQueue.length > 0) {
          this.playNextSong(interaction, voiceChannel);
        }
      }, 2000);
    }
  },
};
