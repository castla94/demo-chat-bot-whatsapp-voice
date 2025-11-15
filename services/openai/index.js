import OpenAI from "openai";
import { generatePrompt, generatePromptDetermine } from "./prompt.js";
import { getWhatsappCredit, postWhatsappCredit, postWhatsappConversation, promptGetWhatsapp } from '../aws/index.js';
import { defaultLogger } from '../../helpers/cloudWatchLogger.js';
import dotenv from 'dotenv';
dotenv.config();

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

export const calculateCostInDollars = (promptTokens, completionTokens) => {
    const inputCost = (promptTokens / 1000) * 0.00015;
    const outputCost = (completionTokens / 1000) * 0.0006;
    return inputCost + outputCost;
};

export const calculateCredits = (promptTokens, completionTokens) => {
    const dollarsAmount = calculateCostInDollars(promptTokens, completionTokens) / 0.001;
    return parseFloat(dollarsAmount.toFixed(2));
};


export async function processTokenUsage(responseOpenAI, availableCredits, userId, numberPhone, name) {
    const { prompt_tokens, completion_tokens } = responseOpenAI.usage;
    
    defaultLogger.info('Créditos disponibles', {
        userId,
        numberPhone,
        name,
        availableCredits,
        action: 'check_credits',
        file: 'openai/index.js'
    });

    const cost = 1//calculateCredits(prompt_tokens, completion_tokens);
    
    defaultLogger.info('Costo de operación calculado', {
        userId,
        numberPhone,
        name,
        cost,
        action: 'calculate_cost',
        file: 'openai/index.js'
    });

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

    return cost;
}



export const runAnalyzeImage = async (base64Image,phone,name) => {

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

        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: "Envio, imagen con informacion solicitada, analiza y responde en formato texto."
                        },
                        {
                            type: "image_url",
                            image_url: { url: `data:image/jpeg;base64,${base64Image}` }
                        },
                    ],
                },
            ],
            store: true,
        });

        //await processTokenUsage(response, availableCredits, userId, numberPhone, name);

        return response.choices[0].message.content;
    } catch (error) {
        defaultLogger.error('Error analyzing image', {
            error: error.message,
            stack: error.stack,
            action: 'analyze_image_error',
            file: 'openai/index.js'
        });
        throw error;
    }
};

export const run = async (name, history, question, phone,imageBase64 = "") => {
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
            temperature: 0,
            max_tokens: 800,
            top_p: 1,
            frequency_penalty: 0,
            presence_penalty: 0,
        });
        const type = imageBase64 !== "" ? 'imagen' : '';
        await postWhatsappConversation(phone, question, response.choices[0].message.content,imageBase64,type);
        await processTokenUsage(response, availableCredits, userId, numberPhone, name);

        return response.choices[0].message.content.replace(/\*\*/g, '*');
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

export const runDetermine = async (history, phone) => {
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
            temperature: 0.5,
            max_tokens: 800,
            top_p: 0.5,
            frequency_penalty: 0,
            presence_penalty: 0,
        });

        await processTokenUsage(response, availableCredits, userId, numberPhone, name);

        return response.choices[0].message.content.replace(/\*\*/g, '*');
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
export const runAnalyzeText = async (text) => {
    const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
            { role: "system", content: "Analiza el texto de este mensaje y ajustalo a un formato estándar donde solo tomes en cuenta la informacion capturada del usuario" },
            { role: "user", content: `${text}` },
        ],
    });

    return response.choices[0].message.content;
}

// Función para analizar el texto extraído
export const runUpdatePromptServicesProduct = async (text) => {
    const whatsappPrompt = await promptGetWhatsapp()

    const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
            { role: "system", content: "Analiza y actualiza la información en prompt_servicio_productos con los nuevos datos de actualizacion_servicio_productos. " +
                "Actualiza los siguientes aspectos:\n" +
                "1. Inventario de productos y niveles de stock\n" +
                "2. Disponibilidad de alquiler y programación\n" +
                "3. Calendarios de servicios y franjas horarias\n" +
                "4. Precios y condiciones si aplica\n" +
                "5. Especificaciones de productos o detalles de servicios\n\n" +
                "Mantén la consistencia y el formato de los datos mientras integras la nueva información. " +
                "Asegúrate de que todas las actualizaciones se reflejen correctamente en la estructura final de prompt_servicio_productos. " +
                "Maneja la información específica de fechas con precisión y valida todos los cambios de inventario." +
                "Debes respetar el formato de prompt_servicio_productos y retornar la nueva informacion actualizada en el mismo formato"
            },
            { role: "user", content: `Tienes este contenido y necesito que lo tomes como referencia para 
                actualizar la informacon: ${whatsappPrompt.products} luego ajustar de acuerdo a estos datos, modifica el formato de la informacion original
                 solo que cambia las partes necesarias para actualizar la informacion  y ademas responde en formato text 
                 y manten tambien el formato original no añadas informacion adicional solo el horario asignado para que 
                 quede ocupado o el stock al inventario sea el canso que corresponda: ${text}` },
        ],
    });

    return response.choices[0].message.content;
}