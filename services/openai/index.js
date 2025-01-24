const OpenAI = require("openai");
const { generatePrompt, generatePromptDetermine } = require("./prompt.js");
const { getWhatsappCredit, postWhatsappCredit, postWhatsappConversation } = require('../aws/index.js');
const { defaultLogger } = require('../../helpers/cloudWatchLogger.js');
require('dotenv').config();

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

const calculateCostInDollars = (promptTokens, completionTokens) => {
    const inputCost = (promptTokens / 1000) * 0.00015;
    const outputCost = (completionTokens / 1000) * 0.0006;
    return inputCost + outputCost;
};

const calculateCredits = (promptTokens, completionTokens) => {
    const dollarsAmount = calculateCostInDollars(promptTokens, completionTokens) / 0.01;
    return parseFloat(dollarsAmount.toFixed(2));
};

async function processTokenUsage(responseOpenAI, availableCredits, userId, numberPhone, name) {
    const { prompt_tokens, completion_tokens } = responseOpenAI.usage;
    
    defaultLogger.info('Créditos disponibles', {
        userId,
        numberPhone,
        name,
        availableCredits,
        action: 'check_credits',
        file: 'openai/index.js'
    });

    const cost = calculateCredits(prompt_tokens, completion_tokens);
    
    defaultLogger.info('Costo de operación calculado', {
        userId,
        numberPhone,
        name,
        cost,
        action: 'calculate_cost',
        file: 'openai/index.js'
    });

    if (availableCredits >= cost) {
        const newCredits = parseFloat((availableCredits - cost).toFixed(2));
        defaultLogger.info('Actualizando créditos', {
            userId,
            numberPhone,
            name,
            newCredits,
            action: 'update_credits',
            file: 'openai/index.js'
        });
        await postWhatsappCredit(String(newCredits));
    }

    return cost;
}

const run = async (name, history, question, phone) => {
    const userId = phone; // Usando el teléfono como userId por consistencia
    const numberPhone = phone;

    try {
        const availableCredits = await getWhatsappCredit();
        
        defaultLogger.info('Verificando créditos para consulta', {
            userId,
            numberPhone,
            name,
            availableCredits,
            action: 'credit_check',
            file: 'openai/index.js'
        });

        if (availableCredits <= 0) {
            defaultLogger.info('Sin créditos disponibles', {
                userId,
                numberPhone,
                name,
                action: 'no_credits',
                file: 'openai/index.js'
            });
            return "¡Hola! 👋 Gracias por contactarnos. En este momento no podemos atender tu consulta, pero no te preocupes, nos pondremos en contacto contigo lo antes posible. 🙏\nSi necesitas ayuda urgente, puedes dejar un mensaje con los detalles de tu consulta, y te responderemos tan pronto como podamos.\n¡Gracias por tu paciencia! 😊";
        }

        const prompt = await generatePrompt(name, question);
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: prompt },
                ...history
            ],
            temperature: 1,
            max_tokens: 800,
            top_p: 1,
            frequency_penalty: 0,
            presence_penalty: 0,
        });

        await postWhatsappConversation(phone, question, response.choices[0].message.content);
        await processTokenUsage(response, availableCredits, userId, numberPhone, name);

        return response.choices[0].message.content;
    } catch (error) {
        defaultLogger.error('Error en procesamiento de consulta', {
            userId,
            numberPhone,
            name,
            error: error.message,
            stack: error.stack,
            action: 'run_error',
            file: 'openai/index.js'
        });
        throw error;
    }
};

const runDetermine = async (history, phone) => {
    const userId = phone;
    const numberPhone = phone;
    const name = '';

    try {
        const availableCredits = await getWhatsappCredit();
        
        defaultLogger.info('Verificando créditos para determinación', {
            userId,
            numberPhone,
            availableCredits,
            action: 'determine_credit_check',
            file: 'openai/index.js'
        });

        if (availableCredits <= 0) {
            defaultLogger.info('Sin créditos disponibles para determinación', {
                userId,
                numberPhone,
                action: 'determine_no_credits',
                file: 'openai/index.js'
            });
            return "¡Hola! 👋 Gracias por contactarnos. En este momento no podemos atender tu consulta, pero no te preocupes, nos pondremos en contacto contigo lo antes posible. 🙏\nSi necesitas ayuda urgente, puedes dejar un mensaje con los detalles de tu consulta, y te responderemos tan pronto como podamos.\n¡Gracias por tu paciencia! 😊";
        }

        const prompt = generatePromptDetermine();
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: prompt },
                ...history
            ],
            temperature: 1,
            max_tokens: 800,
            top_p: 1,
            frequency_penalty: 0,
            presence_penalty: 0,
        });

        await processTokenUsage(response, availableCredits, userId, numberPhone, name);

        return response.choices[0].message.content;
    } catch (error) {
        defaultLogger.error('Error en determinación', {
            userId,
            numberPhone,
            error: error.message,
            stack: error.stack,
            action: 'determine_error',
            file: 'openai/index.js'
        });
        throw error;
    }
};


// Función para analizar el texto extraído
const runAnalyzeText = async (text) => {
    const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
            { role: "system", content: "Analiza el texto de este mensaje y ajustalo a un formato estándar donde solo tomes en cuenta la informacion capturada del usuario" },
            { role: "user", content: `${text}` },
        ],
    });

    return response.choices[0].message.content;
}

module.exports = { run, runDetermine, runAnalyzeText };
