const OpenAI = require("openai");
const fs = require('fs');
const { runAnalyzeImage } = require('../openai/index.js');

const { defaultLogger } = require('../../helpers/cloudWatchLogger');

async function processImage(imagePath,phone,name) {
    try {
        // Verificar que el archivo existe
        if (!fs.existsSync(imagePath)) {
            defaultLogger.error('Archivo de imagen no encontrado', {
                path: imagePath,
                error: 'File not found',
                action: 'process_image',
                file: 'image/index.js'
            });
            throw new Error("No se encuentra el archivo de imagen");
        }

        const imageBuffer = fs.readFileSync(imagePath);
        const base64Image = imageBuffer.toString('base64');

        // Llamada a la API de OpenAI para analizar la imagen
        const respuesta = await runAnalyzeImage(base64Image,phone,name)

        if(respuesta === "¡Hola! 👋 Gracias por contactarnos. En este momento no podemos atender tu consulta, pero no te preocupes, nos pondremos en contacto contigo lo antes posible. 🙏\nSi necesitas ayuda urgente, puedes dejar un mensaje con los detalles de tu consulta, y te responderemos tan pronto como podamos.\n¡Gracias por tu paciencia! 😊"){
            throw new Error("No creditos insuficientes");
        }

        defaultLogger.info('Imagen procesada exitosamente', {
            path: imagePath,
            action: 'image_processed',
            file: 'image/index.js'
        });

        return {
            text:respuesta,
            img:base64Image
        }

    } catch (error) {
        defaultLogger.error('Error procesando imagen', {
            path: imagePath,
            error: error.message,
            stack: error.stack,
            action: 'process_image_error',
            file: 'image/index.js'
        });
        throw error;
    }
}

module.exports = { processImage };