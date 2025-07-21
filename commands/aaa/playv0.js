// commands/play.js
const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
} = require("@discordjs/voice");
const youtubedl = require("youtube-dl-exec");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

const COOKIES_PATH = path.resolve(__dirname, "../config/youtube-cookies.txt");
const COOKIES_ENV_VAR = "YT_COOKIES_B64";
const PROXY = "http://47.74.46.81:11310";
const INVIDIOUS_API = "https://invidious.snopyta.org"; // 安定ノードを選ぶこと

// 起動時に環境変数から cookies.txt を復元
if (process.env[COOKIES_ENV_VAR]) {
  try {
    const decoded = Buffer.from(
      process.env[COOKIES_ENV_VAR],
      "base64",
    ).toString("utf-8");
    fs.mkdirSync(path.dirname(COOKIES_PATH), { recursive: true });
    fs.writeFileSync(COOKIES_PATH, decoded, { encoding: "utf-8" });
    console.log("✅ youtube-cookies.txt を環境変数から復元しました。");
  } catch (err) {
    console.error("❌ cookies.txt の復元に失敗しました:", err);
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("play")
    .setDescription("YouTubeの音楽を再生するよ")
    .addStringOption((option) =>
      option.setName("url").setDescription("YouTubeのURL").setRequired(true),
    ),

  async execute(interaction) {
    const url = interaction.options.getString("url");
    const voiceChannel = interaction.member?.voice?.channel;

    if (!voiceChannel) {
      return interaction.reply("ボイスチャンネルに入ってから使ってね！");
    }

    await interaction.deferReply();

    const fallbackOrder = [
      this.tryYtDlpDefault,
      this.tryYtDlpWithProxyCookies,
      this.tryInvidiousApi,
    ];

    for (let method of fallbackOrder) {
      try {
        const songInfo = await method.call(this, url);
        return await this.play(interaction, voiceChannel, songInfo);
      } catch (err) {
        console.warn(`Fallback method failed: ${method.name}`, err.message);
      }
    }

    await interaction.editReply(
      "再生時にエラーが発生しました。いずれの方法でも再生できないため発生しています、数日後お試しください。",
    );
  },

  async tryYtDlpDefault(url) {
    const info = await youtubedl(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noCallHome: true,
      noCheckCertificate: true,
      preferFreeFormats: true,
      youtubeSkipDashManifest: true,
      noPlaylist: true,
      ignoreErrors: true,
    });
    return this.extractSongInfo(info, url);
  },

  async tryYtDlpWithProxyCookies(url) {
    const info = await youtubedl(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noCallHome: true,
      noCheckCertificate: true,
      preferFreeFormats: true,
      youtubeSkipDashManifest: true,
      noPlaylist: true,
      ignoreErrors: true,
      proxy: PROXY,
      cookies: COOKIES_PATH,
    });
    return this.extractSongInfo(info, url);
  },

  async tryInvidiousApi(url) {
    const videoId = this.extractVideoId(url);
    if (!videoId) throw new Error("Invalid YouTube URL");
    const res = await fetch(`${INVIDIOUS_API}/api/v1/videos/${videoId}`);
    if (!res.ok) throw new Error("Invidious fetch failed");
    const info = await res.json();

    const audio = info.formatStreams.find((f) => f.mimeType?.includes("audio"));
    if (!audio) throw new Error("No audio stream in Invidious response");

    return {
      url: audio.url,
      title: info.title,
      thumbnail: info.videoThumbnails?.[0]?.url || null,
      duration: info.lengthSeconds ? parseInt(info.lengthSeconds) : null,
      uploader: info.author || "YouTube",
      isDirectAudio: true,
    };
  },

  extractSongInfo(info, originalUrl) {
    if (!info || (!info.formats && !info.url)) {
      throw new Error("動画情報が取得できませんでした");
    }
    return {
      url: originalUrl,
      title: info.title || "タイトル不明",
      thumbnail: info.thumbnail || info.thumbnails?.[0]?.url || null,
      duration: info.duration ? Math.floor(info.duration) : null,
      uploader: info.uploader || info.channel || "投稿者不明",
    };
  },

  async play(interaction, voiceChannel, songInfo) {
    const guildId = interaction.guild.id;
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guildId,
      adapterCreator: interaction.guild.voiceAdapterCreator,
    });

    const stream = songInfo.isDirectAudio
      ? songInfo.url
      : youtubedl.exec(songInfo.url, {
          output: "-",
          format: "bestaudio[ext=webm]/bestaudio",
          audioFormat: "wav",
          noWarnings: true,
          noCallHome: true,
          noCheckCertificate: true,
          noPlaylist: true,
          preferFreeFormats: true,
          ignoreErrors: true,
          proxy: PROXY,
          cookies: COOKIES_PATH,
        }).stdout;

    const resource = createAudioResource(stream, {
      inputType: "arbitrary",
    });

    const player = createAudioPlayer();
    player.play(resource);
    connection.subscribe(player);

    const embed = new EmbedBuilder()
      .setTitle("🎵 再生中")
      .setDescription(`**[${songInfo.title}](${songInfo.url})**`)
      .setColor(0x00ff00)
      .setFooter({ text: songInfo.uploader });
    if (songInfo.thumbnail) embed.setThumbnail(songInfo.thumbnail);
    if (songInfo.duration) {
      const min = Math.floor(songInfo.duration / 60);
      const sec = songInfo.duration % 60;
      embed.addFields({
        name: "再生時間",
        value: `${min}:${sec.toString().padStart(2, "0")}`,
        inline: true,
      });
    }

    await interaction.editReply({ content: null, embeds: [embed] });
  },

  extractVideoId(url) {
    const regex =
      /(?:v=|youtu\.be\/|\/v\/|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/;
    const match = url.match(regex);
    return match?.[1] || null;
  },
};
