const OpenAI = require("openai");
const { generatePrompt, generatePromptDetermine } = require("./prompt.js");
const { getWhatsappCredit,postWhatsappCredit,postWhatsappConversation } = require('../aws');
require('dotenv').config();

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Función para calcular el costo de la solicitud
function calcularCostoEnDolares(promptTokens, completionTokens) {
    const costoEntrada = (promptTokens / 1000) * 0.00015;
    const costoSalida = (completionTokens / 1000) * 0.0006;
    return costoEntrada + costoSalida;
  }

// Función para calcular el costo de la solicitud en créditos
function calcularCosto(promptTokens, completionTokens) {
    const costoEnDolares = calcularCostoEnDolares(promptTokens, completionTokens) / 0.01;
    return parseFloat(costoEnDolares.toFixed(2))
}

async function processTokenUse (responseOpenia,creditosDisponibles){

    // Obtener el uso de tokens de la respuesta
    const usage = responseOpenia.usage;
    const promptTokens = usage.prompt_tokens;
    const completionTokens = usage.completion_tokens;
    console.log("creditosDisponibles:",creditosDisponibles)

    // Calcular el costo
    const costo = calcularCosto(promptTokens, completionTokens);
    console.log("costo openia:",costo)

    // Verificar si el usuario tiene suficientes créditos
    if (creditosDisponibles >= costo) {
        // Restamos los créditos
        let nuevosCreditos = creditosDisponibles - costo;
        nuevosCreditos = parseFloat(nuevosCreditos.toFixed(2))
        console.log("nuevosCreditos:",nuevosCreditos)
        // Actualizamos los créditos del usuario
        await postWhatsappCredit(String(nuevosCreditos));
    }

    return costo;

}


/**
 * 
 * @param {string} name 
 * @param {Array} history 
 * @returns {Promise<string>}
 */
const run = async (name, history,question,phone) => {
    let creditosDisponibles = await getWhatsappCredit();
    if(creditosDisponibles <= 0){
        return "¡Hola! 👋 Gracias por contactarnos. En este momento no podemos atender tu consulta, pero no te preocupes, nos pondremos en contacto contigo lo antes posible. 🙏\nSi necesitas ayuda urgente, puedes dejar un mensaje con los detalles de tu consulta, y te responderemos tan pronto como podamos.\n¡Gracias por tu paciencia! 😊";
    }
    const prompt = await generatePrompt(name,question);
    const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
            {
                "role": "system",
                "content": prompt
            },
            ...history
        ],
        temperature: 1,
        max_tokens: 800,
        top_p: 1,
        frequency_penalty: 0,
        presence_penalty: 0,
    });

    await postWhatsappConversation(phone,question,response.choices[0].message.content);
    await processTokenUse(response,creditosDisponibles)

    return response.choices[0].message.content;
};

/**
 * 
 * @param {Array<ChatCompletionMessageParam>} history 
 * @returns {Promise<string>}
 */
const runDetermine = async (history,phone) => {
    let creditosDisponibles = await getWhatsappCredit();
    if(creditosDisponibles <= 0){
        return "¡Hola! 👋 Gracias por contactarnos. En este momento no podemos atender tu consulta, pero no te preocupes, nos pondremos en contacto contigo lo antes posible. 🙏\nSi necesitas ayuda urgente, puedes dejar un mensaje con los detalles de tu consulta, y te responderemos tan pronto como podamos.\n¡Gracias por tu paciencia! 😊";
    }

    const prompt = generatePromptDetermine();
    const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
            {
                "role": "system",
                "content": prompt
            },
            ...history
        ],
        temperature: 1,
        max_tokens: 800,
        top_p: 1,
        frequency_penalty: 0,
        presence_penalty: 0,
    });

    await processTokenUse(response,creditosDisponibles)

    return response.choices[0].message.content;
};

module.exports = { run,runDetermine };
