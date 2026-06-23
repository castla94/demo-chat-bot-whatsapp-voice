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
            model: "gpt-4.1-mini",
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



async function classifyIntent(question) {
    const apiKey = process.env.OPENAI_API_KEY;
    const fallbackClassification = {
        intent: "availability",
        requires_strong_model: false
    };

    const normalizeClassification = (classification) => {
        const allowedIntents = ["availability", "reservation", "other"];
        const intent = allowedIntents.includes(classification?.intent)
            ? classification.intent
            : fallbackClassification.intent;

        return {
            intent,
            requires_strong_model: Boolean(classification?.requires_strong_model)
        };
    };

    defaultLogger.info('Iniciando classifyIntent', {
        question,
        action: 'classify_intent_start',
        file: 'openai/index.js'
    });

    if (hasDateLikeReference(question)) {
        return {
            intent: "availability",
            requires_strong_model: true
        };
    }

    const payload = {
        model: "gpt-4.1-mini",
        input: [
            {
                role: "system",
                content: [{
                    type: "input_text",
                    text: `
Clasifica la intención del mensaje del usuario.
Si pregunta por disponibilidad, horarios, agenda, o envía una fecha usa "availability".
Si quiere reservar, agendar usa "reservation".
Si no calza claramente, usa "other".
Marca requires_strong_model en true solo cuando el mensaje sea ambiguo, complejo o requiera mayor razonamiento.
IMPORTANTE: si el usuario incluye cualquier fecha o referencia temporal en cualquier formato, SIEMPRE clasifica como "availability" y "requires_strong_model": true.

Considera como fecha o referencia temporal cualquiera de estos ejemplos:
- 2026-06-26
- 26/06/2026
- 26-06-2026
- 26 de junio
- viernes 26
- próximo viernes
- manana
- hoy
- pasado manana
- este fin de semana
- junio

Categorias:
- availability
- reservation
- other

Responde SOLO JSON:

{
  "intent":"availability",
  "requires_strong_model":true
}
`
                }]
            },
            {
                role: "user",
                content: [{
                    type: "input_text",
                    text: question
                }]
            }
        ],
        text: {
            format: { type: "text" }
        },
        temperature: 0
    };

    try {
        const response = await global.fetch(
            "https://api.openai.com/v1/responses",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${apiKey}`
                },
                body: JSON.stringify(payload)
            }
        );

        const data = await response.json();
        const rawText = String(data.output?.[0]?.content?.[0]?.text || "").trim();

        try {
            return normalizeClassification(JSON.parse(rawText || "{}"));
        } catch {
            const normalizedText = rawText
                .replace(/^```json\s*/i, "")
                .replace(/^```\s*/i, "")
                .replace(/\s*```$/i, "")
                .trim();

            const jsonMatch = normalizedText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    return normalizeClassification(JSON.parse(jsonMatch[0]));
                } catch (error) {
                    defaultLogger.warn('classifyIntent parse_error', {
                        question,
                        message: error?.message || "",
                        rawText,
                        action: 'classify_intent_parse_error',
                        file: 'openai/index.js'
                    });
                }
            }

            return fallbackClassification;
        }
    } catch (error) {
        defaultLogger.warn('Error en classifyIntent, usando fallback', {
            question,
            error: error.message,
            action: 'classify_intent_fallback',
            file: 'openai/index.js'
        });
        return fallbackClassification;
    }
}

function hasDateLikeReference(question) {
    const text = String(question || "").toLowerCase().trim();

    if (!text) {
        return false;
    }

    const patterns = [
        /\b\d{4}-\d{1,2}-\d{1,2}\b/,
        /\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b/,
        /\b\d{1,2}\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(\s+de\s+\d{4})?\b/,
        /\b(lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo)\s+\d{1,2}\b/,
        /\b(hoy|manana|mañana|ayer|pasado manana|pasado mañana|proximo|próximo|este|semana proxima|semana próxima|fin de semana|mes que viene|mes proximo|mes próximo)\b/,
        /\b(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b/,
        /\b(lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo)\b/
    ];

    return patterns.some((pattern) => pattern.test(text));
}


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
        const classification = await classifyIntent(question);
        const modelSelected = classification?.requires_strong_model ? "gpt-4o" : "gpt-4.1-mini";
        defaultLogger.info('Modelo seleccionado para consulta', {
            userId,
            numberPhone,
            name,
            modelSelected,
            classification,
            action: 'model_selection',
            file: 'openai/index.js'
        });

        const response = await openai.chat.completions.create({
            model: modelSelected,
            messages: [
                { role: "system", content: prompt },
                ...history
            ],
            temperature: 0,
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
            model: "gpt-4.1-mini",
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
        model: "gpt-4.1-mini",
        messages: [
            { role: "system", content: "Analiza el texto de este mensaje y ajustalo a un formato estándar donde solo tomes en cuenta la informacion capturada del usuario" },
            { role: "user", content: `${text}` },
        ],
    });

    return response.choices[0].message.content;
}

// Función para analizar el texto extraído
export const runUpdatePromptServicesProduct = async (text) => {
    const whatsappPrompt = await promptGetWhatsapp(text)

    const response = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
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
