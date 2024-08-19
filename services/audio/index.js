const { downloadMediaMessage } = require("@adiwajshing/baileys");
const OpenAI = require("openai");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs");
ffmpeg.setFfmpegPath(ffmpegPath);

const voiceToText = async (path) => {
    if (!fs.existsSync(path)) {
        throw new Error("No se encuentra el archivo");
    }
    try {
        const openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
        });

        const resp = await openai.audio.transcriptions.create({
            file: fs.createReadStream(path),
            model: "whisper-1",
        });

        return resp.text;
    } catch (err) {
        console.log("voiceToText: ",err);
        return "ERROR";
    }
};

const convertOggMp3 = async (inputStream, outStream) => {
    return new Promise((resolve, reject) => {
        ffmpeg(inputStream)
            .audioQuality(96)
            .toFormat("mp3")
            .save(outStream)
            .on("progress", (p) => null)
            .on("end", () => {
                resolve(true);
            });
    });
};

const handlerAI = async (ctx,phone) => {
    try {
        const buffer = await downloadMediaMessage(ctx, "buffer");
        const pathTmpOgg = `${process.cwd()}/audio/voice-note-${Date.now()}-${phone}.ogg`;
        const pathTmpMp3 = `${process.cwd()}/audio/voice-note-${Date.now()}-${phone}.mp3`;
        await fs.writeFileSync(pathTmpOgg, buffer);
        await convertOggMp3(pathTmpOgg, pathTmpMp3);
        const text = await voiceToText(pathTmpMp3);
        fs.unlink(pathTmpMp3, (error) => {
            if (error) throw error;
        });
        fs.unlink(pathTmpOgg, (error) => {
            if (error) throw error;
        });
        return text;
    } catch (err) {
        console.log("handlerAI:",err);
        return "ERROR";
    }
};

module.exports = { handlerAI };