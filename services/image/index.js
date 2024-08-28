const openai = require("openai");
const fs = require('fs');

// Configurar la API de OpenAI
openai.apiKey = process.env.OPENAI_API_KEY; // Asegúrate de tener tu API Key configurada

// Función para leer la imagen
async function readImage(filePath) {
    return fs.readFileSync(filePath);
}

// Función para extraer texto de la imagen usando OpenAI
async function extractTextFromImage(imagePath) {
    const imageBuffer = await readImage(imagePath);

    const response = await openai.images.edit({
        image: imageBuffer,
        prompt: "Extract the text from the image",
        n: 1,
        size: "1024x1024",
        response_format: "text"
    });

    const extractedText = response.data; // Dependiendo de cómo OpenAI devuelve la respuesta
    return extractedText;
}

// Función para analizar el texto extraído
async function analyzeText(text) {
    const response = await openai.chat.completions.create({
        model: "gpt-4",
        messages: [
            { role: "system", content: "Actúa como un asistente que analiza información extraída de imágenes." },
            { role: "user", content: `Por favor, analiza el siguiente texto extraído de una imagen:\n\n${text}` },
        ],
    });

    return response.choices[0].message.content;
}

// Función principal
async function processImage(imagePath) {
    try {
        const extractedText = await extractTextFromImage(imagePath);
        console.log("Texto Extraído:", extractedText);

        const analysis = await analyzeText(extractedText);
        console.log("Análisis:", analysis);
    } catch (error) {
        console.error("Error:", error);
    }
}
// Proveer la ruta a tu imagen
const imagePath = '/Applications/XAMPP/xamppfiles/htdocs/demo-chat-bot-whatsapp-voice/media/imagen56974593859-1723676021166.jpg';
processImage(imagePath);
