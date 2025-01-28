const OpenAI = require("openai");
const fs = require('fs');
const { defaultLogger } = require('../../helpers/cloudWatchLogger');

async function processImage(imagePath) {
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

        const openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
        });

        // Llamada a la API de OpenAI para analizar la imagen
        const imagen = fs.createReadStream(imagePath);
        const respuesta = await openai.createImageVariation({
            image: imagen,
        });

        defaultLogger.info('Imagen procesada exitosamente', {
            path: imagePath,
            action: 'image_processed',
            file: 'image/index.js'
        });

        return respuesta.data;

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