const { downloadMediaMessage } = require("@whiskeysockets/baileys");
const OpenAI = require("openai");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs");
const { defaultLogger } = require('../../helpers/cloudWatchLogger');

ffmpeg.setFfmpegPath(ffmpegPath);


const textToVoice = async (userId, numberPhone, name, textToVoice) => {


    try {
        const openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
        });

        defaultLogger.info('Iniciando conversión de texto a voz', {
            userId,
            numberPhone,
            name,
            action: 'text_to_voice_start',
            file: 'audio/index.js'
        });

        // Generate an audio response to the given prompt
        const response = await openai.chat.completions.create({
            model: "gpt-4o-audio-preview",
            modalities: ["text", "audio"],
            audio: { voice: "onyx", format: "opus" },
            messages: [
                {
                    role: "user",
                    content: "Por favor, reproduce el siguiente texto exactamente como está escrito, "
                    +"Habla con un tono cálido y natural, como si estuvieras conversando con un amigo."
                    +" Usa pausas sutiles entre ideas y frases para dar un ritmo fluido y humano. Varía "
                    +"ligeramente la entonación para enfatizar palabras clave y sonar más expresivo. "
                    +"Evita hablar demasiado rápido o de manera monótona; en su lugar, añade pequeñas "
                    +"respiraciones y cambios en el ritmo para que la conversación fluya de manera orgánica: "
                    +textToVoice
                }
            ],
            store: true,
        });

        // Write audio data to a file
        var pathAudio = `${process.cwd()}/audio/voice-note-${Date.now()}-${numberPhone}.opus`;

        defaultLogger.info('Guardando archivo de audio', {
            userId,
            numberPhone,
            name,
            path: pathAudio,
            action: 'save_audio_file',
            file: 'audio/index.js'
        });

        await fs.writeFileSync(
            pathAudio,
            Buffer.from(response.choices[0].message.audio.data, 'base64'),
            { encoding: "utf-8" }
        );

        defaultLogger.info('Conversión de texto a voz completada exitosamente', {
            userId,
            numberPhone,
            name,
            path: pathAudio,
            action: 'text_to_voice_success',
            file: 'audio/index.js'
        });

        return pathAudio;

    } catch (err) {
        defaultLogger.error('Error en generando audio', {
            userId,
            numberPhone,
            name,
            error: err.message,
            stack: err.stack,
            action: 'transcription_error',
            file: 'audio/index.js'
        });
        return "ERROR";
    }
};
const voiceToText = async (path, userId, numberPhone, name) => {
    if (!fs.existsSync(path)) {
        defaultLogger.error('Archivo de audio no encontrado', {
            userId,
            numberPhone,
            name,
            path,
            error: 'File not found',
            action: 'voice_to_text',
            file: 'audio/index.js'
        });
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
        defaultLogger.error('Error en transcripción de audio', {
            userId,
            numberPhone,
            name,
            error: err.message,
            stack: err.stack,
            action: 'transcription_error',
            file: 'audio/index.js'
        });
        return "ERROR";
    }
};

const convertOggMp3 = async (inputStream, outStream, userId, numberPhone, name) => {
    return new Promise((resolve, reject) => {
        ffmpeg(inputStream)
            .audioQuality(96)
            .toFormat("mp3")
            .save(outStream)
            .on("progress", (p) => null)
            .on("end", () => {
                defaultLogger.info('Conversión de audio completada', {
                    userId,
                    numberPhone,
                    name,
                    action: 'conversion_complete',
                    file: 'audio/index.js'
                });
                resolve(true);
            })
            .on("error", (err) => {
                defaultLogger.error('Error en conversión de audio', {
                    userId,
                    numberPhone,
                    name,
                    error: err.message,
                    action: 'conversion_error',
                    file: 'audio/index.js'
                });
                reject(err);
            });
    });
};

const handlerAI = async (ctx, phone) => {
    const userId = ctx.key.remoteJid;
    const name = ctx?.pushName ?? '';
    const numberPhone = phone;

    try {

        const buffer = await downloadMediaMessage(ctx, "buffer");
        const pathTmpOgg = `${process.cwd()}/audio/voice-note-${Date.now()}-${phone}.ogg`;
        const pathTmpMp3 = `${process.cwd()}/audio/voice-note-${Date.now()}-${phone}.mp3`;

        await fs.writeFileSync(pathTmpOgg, buffer);
        await convertOggMp3(pathTmpOgg, pathTmpMp3, userId, numberPhone, name);
        const text = await voiceToText(pathTmpMp3, userId, numberPhone, name);

        fs.unlink(pathTmpMp3, (error) => {
            if (error) {
                defaultLogger.error('Error eliminando archivo MP3', {
                    userId,
                    numberPhone,
                    name,
                    error: error.message,
                    action: 'delete_mp3_file',
                    file: 'audio/index.js'
                });
            }
        });

        fs.unlink(pathTmpOgg, (error) => {
            if (error) {
                defaultLogger.error('Error eliminando archivo OGG', {
                    userId,
                    numberPhone,
                    name,
                    error: error.message,
                    action: 'delete_ogg_file',
                    file: 'audio/index.js'
                });
            }
        });

        return text;
    } catch (err) {
        defaultLogger.error('Error en procesamiento de nota de voz', {
            userId,
            numberPhone,
            name,
            error: err.message,
            stack: err.stack,
            action: 'voice_processing_error',
            file: 'audio/index.js'
        });
        return "ERROR";
    }
};

module.exports = { handlerAI, textToVoice };