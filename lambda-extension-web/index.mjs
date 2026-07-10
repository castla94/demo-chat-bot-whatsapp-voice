import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import ffmpegStatic from 'ffmpeg-static';

const BASE_URL = 'https://c0jkurvt19.execute-api.us-east-1.amazonaws.com/DEV';
const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const OPENAI_AUDIO_TRANSCRIPTIONS_URL = 'https://api.openai.com/v1/audio/transcriptions';
const DEFAULT_NO_CREDITS_MESSAGE = "¡Hola! 👋 Gracias por contactarnos. En este momento no podemos atender tu consulta, pero no te preocupes, nos pondremos en contacto contigo lo antes posible. 🙏\nSi necesitas ayuda urgente, puedes dejar un mensaje con los detalles de tu consulta, y te responderemos tan pronto como podamos.\n¡Gracias por tu paciencia! 😊";
const DATE_BASE = [].join('\n');

const PROMPT = ``;

let requestLogContext = {
  emailToken: "",
  phone: ""
};

const setLogContext = ({ emailToken = "", phone = "" } = {}) => {
  requestLogContext = {
    emailToken: String(emailToken || "").trim(),
    phone: String(phone || "").trim()
  };
};

const buildLogMeta = (meta = {}) => ({
  ...requestLogContext,
  ...meta
});

const logInfo = (message, meta = {}) => console.log(message, buildLogMeta(meta));
const logWarn = (message, meta = {}) => console.warn(message, buildLogMeta(meta));
const logError = (message, meta = {}) => console.error(message, buildLogMeta(meta));

const getOpenAIApiKey = () => process.env.OPENAI_API_KEY || "";

const fetchJson = async (url, options = {}) => {
  const response = await global.fetch(url, options);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const errorMessage = data?.error?.message || `Request failed with status ${response.status}`;
    throw new Error(errorMessage);
  }

  return data;
};

const buildUrl = (baseUrl, queryParams = {}) => {
  const url = new URL(baseUrl);
  Object.entries(queryParams).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  });
  return url.toString();
};

const httpGet = async (url, queryParams = {}) => (
  fetchJson(buildUrl(url, queryParams), {
    method: 'GET'
  })
);

const httpPost = async (url, body, queryParams = {}, headers = {}) => (
  fetchJson(buildUrl(url, queryParams), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers
    },
    body: JSON.stringify(body)
  })
);

const createOpenAIChatCompletion = async (payload) => (
  httpPost(
    OPENAI_CHAT_COMPLETIONS_URL,
    payload,
    {},
    {
      Authorization: `Bearer ${getOpenAIApiKey()}`
    }
  )
);

const createOpenAIAudioTranscription = async (formData) => {
  const response = await global.fetch(OPENAI_AUDIO_TRANSCRIPTIONS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getOpenAIApiKey()}`
    },
    body: formData
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const errorMessage = data?.error?.message || `Request failed with status ${response.status}`;
    throw new Error(errorMessage);
  }

  return data;
};

const truncateTextForLog = (value, maxLength = 3000) => {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...[truncated]`;
};

const extractBase64Payload = (value = "") => {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }

  const dataUrlMatch = text.match(/^data:.*?;base64,(.+)$/);
  return dataUrlMatch ? dataUrlMatch[1] : text;
};

const writeBase64AudioToTempFile = async (audioBase64, extension, phone) => {
  const base64Payload = extractBase64Payload(audioBase64);

  if (!base64Payload) {
    return "";
  }

  const tempFilePath = path.join(
    os.tmpdir(),
    `voice-note-${Date.now()}-${phone || 'anonymous'}.${extension}`
  );

  await fs.writeFile(tempFilePath, Buffer.from(base64Payload, 'base64'));
  return tempFilePath;
};

const resolveFfmpegExecutable = () => {
  const candidates = [
    process.env.FFMPEG_PATH,
    ffmpegStatic
  ].filter(Boolean);

  if (candidates.length === 0) {
    throw new Error(
      'No se encontro ffmpeg. Instala ffmpeg-static (para que descargue el binario) o define FFMPEG_PATH.'
    );
  }

  return candidates[0];
};

const convertAudioToMp3 = async (inputPath, outputPath) => (
  new Promise((resolve, reject) => {
    const ffmpegExecutable = resolveFfmpegExecutable();
    const args = [
      '-y',
      '-i',
      inputPath,
      '-codec:a',
      'libmp3lame',
      '-q:a',
      '4',
      outputPath
    ];
    const command = `${ffmpegExecutable} ${args.join(' ')}`;
    let stderrOutput = '';

    logInfo('Ejecutando ffmpeg para convertir audio', {
      ffmpegExecutable,
      command,
      inputPath,
      outputPath,
      file: 'index.mjs'
    });

    const child = spawn(ffmpegExecutable, args);

    child.stderr.on('data', (chunk) => {
      stderrOutput += String(chunk || '');
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(outputPath);
        return;
      }

      reject(
        new Error(
          `ffmpeg finalizo con codigo ${code}. ${truncateTextForLog(stderrOutput, 1200)}`
        )
      );
    });
  })
);

const removeTempFile = async (filePath) => {
  if (!filePath) {
    return;
  }

  try {
    await fs.unlink(filePath);
  } catch (error) {
    logWarn('No se pudo eliminar archivo temporal', {
      tempFilePath: filePath,
      error: error.message,
      file: 'lambda-chatbot.mjs'
    });
  }
};

const transcribeAudioBase64ToText = async (audioBase64, phone) => {
  const base64Payload = extractBase64Payload(audioBase64);

  if (!base64Payload) {
    return "";
  }

  const inputPath = await writeBase64AudioToTempFile(audioBase64, 'ogg', phone);
  const outputPath = path.join(
    os.tmpdir(),
    `voice-note-${Date.now()}-${phone || 'anonymous'}.mp3`
  );

  logInfo('Iniciando conversión de audio ogg a mp3', {
    audioBytesApprox: Math.ceil((base64Payload.length * 3) / 4),
    inputPath,
    outputPath,
    file: 'lambda-chatbot.mjs'
  });

  try {
    await convertAudioToMp3(inputPath, outputPath);

    logInfo('Conversión de audio completada', {
      inputPath,
      outputPath,
      file: 'lambda-chatbot.mjs'
    });

    const audioBuffer = await fs.readFile(outputPath);
    const formData = new FormData();
    const audioBlob = new Blob([audioBuffer], { type: 'audio/mpeg' });

    formData.append('file', audioBlob, path.basename(outputPath));
    formData.append('model', 'whisper-1');

    const transcription = await createOpenAIAudioTranscription(formData);
    const transcribedText = String(transcription?.text || "").trim();

    logInfo('Transcripción de audio completada', {
      transcriptionText: truncateTextForLog(transcribedText),
      file: 'lambda-chatbot.mjs'
    });

    return transcribedText;
  } finally {
    await removeTempFile(inputPath);
    await removeTempFile(outputPath);
  }
};

const calculateCostInDollars = (promptTokens, completionTokens) => {
  const inputCost = (promptTokens / 1000) * 0.00015;
  const outputCost = (completionTokens / 1000) * 0.0006;
  return inputCost + outputCost;
};

const calculateCredits = (promptTokens, completionTokens) => {
  const dollarsAmount = calculateCostInDollars(promptTokens, completionTokens) / 0.001;
  return parseFloat(dollarsAmount.toFixed(2));
};

const postWhatsappCredit = async (credit, emailToken) => {
  const endpoint = `${BASE_URL}/whatsapp-setting/credits`;

  try {
    return await httpPost(endpoint, { credit }, { email_bk: emailToken });
  } catch (error) {
    logError('Error registrando créditos', {
      credit,
      error: error.message,
      stack: error.stack,
      file: 'lambda-chatbot.mjs'
    });
    return null;
  }
};

const postWhatsappConversation = async (phone, message_user, message_openia, imageBase64 = "", type = "", type_user = "", emailToken) => {
  const endpoint = `${BASE_URL}/whatsapp-conversation`;

  try {
    return await httpPost(endpoint, {
      phone,
      message_user,
      message_openia,
      imageBase64,
      type,
      type_user
    }, { email_bk: emailToken });
  } catch (error) {
    logError('Error registrando conversación', {
      phone,
      error: error.message,
      stack: error.stack,
      file: 'lambda-chatbot.mjs'
    });
    return null;
  }
};

const getWhatsappConversation = async (number, emailToken) => {
  const endpoint = `${BASE_URL}/whatsapp-conversation`;

  try {
    const response = await httpGet(endpoint, { email: emailToken, number });
    const items = response.item ? response.item.slice(-10) : [];
    const history = [];

    items.forEach((item) => {
      if (item.message_user) {
        history.push({
          role: 'user',
          content: item.message_user
        });
      }

      if (item.message_openia) {
        history.push({
          role: 'assistant',
          content: item.message_openia
        });
      }
    });

    return history;
  } catch (error) {
    logError('Error consultando conversaciones', {
      number,
      error: error.message,
      stack: error.stack,
      file: 'lambda-chatbot.mjs'
    });
    return [];
  }
};

const getWhatsappCredit = async (emailToken) => {
  const endpoint = `${BASE_URL}/whatsapp-setting/credits`;

  try {
    const response = await httpGet(endpoint, { email_bk: emailToken });
    return response.item.credit;
  } catch (error) {
    logError('Error consultando créditos', {
      error: error.message,
      stack: error.stack,
      file: 'lambda-chatbot.mjs'
    });
    return null;
  }
};

const getWhatsappWhitelist = async (phone, emailToken) => {
  const endpoint = `${BASE_URL}/whatsapp-sessions-whitelist`;

  try {
    const response = await httpGet(endpoint, { email_bk: emailToken });
    return response.item.whitelist.includes(phone);
  } catch (error) {
    logError('Error verificando whitelist', {
      phone,
      error: error.message,
      stack: error.stack,
      file: 'lambda-chatbot.mjs'
    });
    return null;
  }
};

const getWhatsapp = async (number, emailToken) => {
  const endpoint = `${BASE_URL}/whatsapp`;

  try {
    return await httpGet(endpoint, { number, email: emailToken });
  } catch (error) {
    logError('Error obteniendo información de WhatsApp', {
      number,
      error: error.message,
      stack: error.stack,
      file: 'lambda-chatbot.mjs'
    });
    return null;
  }
};

const putWhatsapp = async (number, name, status, emailToken) => {
  const endpoint = `${BASE_URL}/whatsapp`;

  try {
    return await httpPost(endpoint, {
      email: emailToken,
      name,
      number,
      status
    });
  } catch (error) {
    logError('Error actualizando estado de WhatsApp', {
      number,
      name,
      status,
      error: error.message,
      stack: error.stack,
      file: 'lambda-chatbot.mjs'
    });
    return null;
  }
};

const putWhatsappEmailVendor = async (number, name, message, image = "", emailToken) => {
  const endpoint = `${BASE_URL}/whatsapp-email-vendor`;

  try {
    const response = await httpPost(endpoint, {
      number,
      email_token: emailToken,
      name,
      message,
      image
    });
    return response.statusCode === 200;
  } catch (error) {
    logError('Error enviando notificación al vendedor', {
      number,
      name,
      error: error.message,
      stack: error.stack,
      file: 'lambda-chatbot.mjs'
    });
    return null;
  }
};

const regexAlarm = async (message, emailToken) => {
  const endpoint = `${BASE_URL}/whatsapp-sessions-alarm/regex`;

  try {
    const response = await httpPost(endpoint, {
      email_token: emailToken,
      message
    });
    return response.statusCode === 200;
  } catch (error) {
    logError('Error verificando alarmas', {
      error: error.message,
      stack: error.stack,
      file: 'lambda-chatbot.mjs'
    });
    return null;
  }
};

const whatsappStatus = async (emailToken) => {
  const endpoint = `${BASE_URL}/whatsapp-statatus`;

  try {
    const response = await httpPost(endpoint, { email: emailToken });
    return JSON.parse(response.body);
  } catch (error) {
    logError('Error obteniendo estado global', {
      error: error.message,
      stack: error.stack,
      file: 'lambda-chatbot.mjs'
    });
    return null;
  }
};

const promptGetWhatsapp = async (question, emailToken) => {
  const endpoint = `${BASE_URL}/whatsapp-prompt`;

  try {
    return await httpPost(endpoint, { email: emailToken, question });
  } catch (error) {
    logError('Error obteniendo prompt', {
      error: error.message,
      stack: error.stack,
      file: 'lambda-chatbot.mjs'
    });
    return null;
  }
};

const promptUpdateProductWhatsapp = async (products, emailToken) => {
  const endpoint = `${BASE_URL}/whatsapp-prompt/update-prompt-product-and-services`;

  try {
    return await httpPost(endpoint, { email: emailToken, products });
  } catch (error) {
    logError('Error actualizando prompt de productos', {
      error: error.message,
      stack: error.stack,
      file: 'lambda-chatbot.mjs'
    });
    return null;
  }
};

const runAnalyzeText = async (text) => {
  const response = await createOpenAIChatCompletion({
    model: "gpt-4.1-mini",
    messages: [
      {
        role: "system",
        content: "Analiza el texto de este mensaje y ajustalo a un formato estándar donde solo tomes en cuenta la informacion capturada del usuario"
      },
      {
        role: "user",
        content: `${text}`
      }
    ]
  });

  return response.choices[0].message.content;
};

const putWhatsappOrderConfirmation = async (name, phone, message, status, emailToken) => {
  const endpoint = `${BASE_URL}/whatsapp-order`;

  const now = new Date();
  const formattedDate = [
    String(now.getDate()).padStart(2, '0'),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getFullYear()).slice(-2),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0')
  ].join('');
  const order_number = `${formattedDate}-${phone}`;

  try {
    const analyzedMessage = await runAnalyzeText(message);
    if (analyzedMessage) {
      message = analyzedMessage;
    }

    await putWhatsappEmailVendor(
      phone,
      name,
      "Información capturada del usuario: \n\n" + message,
      "",
      emailToken
    );
  } catch (error) {
    logError('Error analizando mensaje de orden', {
      message,
      error: error.message,
      stack: error.stack,
      file: 'lambda-chatbot.mjs'
    });
  }

  try {
    return await httpPost(endpoint, {
      name,
      email: emailToken,
      phone,
      message,
      status,
      order_number
    });
  } catch (error) {
    logError('Error confirmando orden', {
      name,
      phone,
      order_number,
      status,
      error: error.message,
      stack: error.stack,
      file: 'lambda-chatbot.mjs'
    });
    return null;
  }
};

const generatePrompt = async (name, question, emailToken) => {
  const whatsappPrompt = await promptGetWhatsapp(question, emailToken);

  if (whatsappPrompt?.prompt) {
    logInfo('Obteniendo prompt desde base de datos', {
      file: 'lambda-chatbot.mjs'
    });
    return whatsappPrompt.prompt
      .replaceAll('{customer_name}', name)
      .replaceAll('{question}', question);
  }

  return PROMPT
    .replaceAll('{customer_name}', name)
    .replaceAll('{context}', DATE_BASE)
    .replaceAll('{question}', question);
};

const processTokenUsage = async (responseOpenAI, availableCredits, userId, numberPhone, name, emailToken) => {
  const { prompt_tokens = 0, completion_tokens = 0 } = responseOpenAI.usage ?? {};

  logInfo('Créditos disponibles', {
    userId,
    numberPhone,
    name,
    availableCredits,
    file: 'lambda-chatbot.mjs'
  });

  const cost = 1 || calculateCredits(prompt_tokens, completion_tokens);
  const newCredits = parseFloat((availableCredits - cost).toFixed(2));

  logInfo('Actualizando créditos', {
    userId,
    numberPhone,
    name,
    cost,
    newCredits,
    file: 'lambda-chatbot.mjs'
  });

  await postWhatsappCredit(String(newCredits), emailToken);
  return cost;
};

const hasDateLikeReference = (question) => {
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
};

const classifyIntent = async (question) => {
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

  logInfo('Iniciando clasificación de intención', {
    question: truncateTextForLog(question),
    file: 'lambda-chatbot.mjs'
  });

  if (hasDateLikeReference(question)) {
    logInfo('Clasificación por referencia temporal detectada', {
      question: truncateTextForLog(question),
      classification: {
        intent: "availability",
        requires_strong_model: true
      },
      file: 'lambda-chatbot.mjs'
    });
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
    const data = await httpPost(
      OPENAI_RESPONSES_URL,
      payload,
      {},
      {
        Authorization: `Bearer ${apiKey}`
      }
    );
    const rawText = String(data.output?.[0]?.content?.[0]?.text || "").trim();
    logInfo('Respuesta cruda de clasificación recibida', {
      question: truncateTextForLog(question),
      rawClassificationText: truncateTextForLog(rawText),
      file: 'lambda-chatbot.mjs'
    });

    try {
      const normalizedClassification = normalizeClassification(JSON.parse(rawText || "{}"));
      logInfo('Clasificación normalizada', {
        question: truncateTextForLog(question),
        classification: normalizedClassification,
        file: 'lambda-chatbot.mjs'
      });
      return normalizedClassification;
    } catch {
      const normalizedText = rawText
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      const jsonMatch = normalizedText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const normalizedClassification = normalizeClassification(JSON.parse(jsonMatch[0]));
          logInfo('Clasificación normalizada desde bloque saneado', {
            question: truncateTextForLog(question),
            classification: normalizedClassification,
            file: 'lambda-chatbot.mjs'
          });
          return normalizedClassification;
        } catch (error) {
          logWarn('classifyIntent parse_error', {
            question: truncateTextForLog(question),
            message: error?.message || "",
            rawText: truncateTextForLog(rawText),
            file: 'lambda-chatbot.mjs'
          });
        }
      }

      logWarn('Usando clasificación fallback tras respuesta no parseable', {
        question: truncateTextForLog(question),
        rawText: truncateTextForLog(rawText),
        fallbackClassification,
        file: 'lambda-chatbot.mjs'
      });
      return fallbackClassification;
    }
  } catch (error) {
    logWarn('Error en classifyIntent, usando fallback', {
      question: truncateTextForLog(question),
      error: error.message,
      fallbackClassification,
      file: 'lambda-chatbot.mjs'
    });
    return fallbackClassification;
  }
};

const runUpdatePromptServicesProduct = async (text, emailToken) => {
  const whatsappPrompt = await promptGetWhatsapp(text, emailToken);

  const response = await createOpenAIChatCompletion({
    model: "gpt-4.1-mini",
    messages: [
      {
        role: "system",
        content: "Analiza y actualiza la información en prompt_servicio_productos con los nuevos datos de actualizacion_servicio_productos. " +
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
      {
        role: "user",
        content: `Tienes este contenido y necesito que lo tomes como referencia para 
                actualizar la informacon: ${whatsappPrompt?.products || ""} luego ajustar de acuerdo a estos datos, modifica el formato de la informacion original
                 solo que cambia las partes necesarias para actualizar la informacion  y ademas responde en formato text 
                 y manten tambien el formato original no añadas informacion adicional solo el horario asignado para que 
                 quede ocupado o el stock al inventario sea el canso que corresponda: ${text}`
      }
    ]
  });

  return response.choices[0].message.content;
};

const ensureImageDataUrl = (imageBase64 = "") => {
  const value = String(imageBase64 || "").trim();
  if (!value) {
    return "";
  }

  if (value.startsWith("data:")) {
    return value;
  }

  return `data:image/jpeg;base64,${value}`;
};

const buildChatCompletionMessages = (prompt, history, question, imageBase64 = "") => {
  const normalizedHistory = normalizeHistory(history);
  const hasDuplicatedLastUserMessage =
    normalizedHistory.length > 0 &&
    normalizedHistory[normalizedHistory.length - 1].role === "user" &&
    normalizedHistory[normalizedHistory.length - 1].content === question;

  const conversationHistory = hasDuplicatedLastUserMessage
    ? normalizedHistory.slice(0, -1)
    : normalizedHistory;

  const messages = [
    { role: "system", content: prompt },
    ...conversationHistory
  ];

  if (imageBase64) {
    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text: question || "Analiza la imagen considerando el historial y responde segun el prompt del sistema."
        },
        {
          type: "image_url",
          image_url: {
            url: ensureImageDataUrl(imageBase64)
          }
        }
      ]
    });
    return messages;
  }

  messages.push({
    role: "user",
    content: question
  });

  return messages;
};

const runChatbot = async (name, history, question, phone, imageBase64 = "", emailToken) => {
  const userId = phone;
  const numberPhone = phone;

  const availableCredits = await getWhatsappCredit(emailToken);

  logInfo('Verificando créditos para consulta', {
    userId,
    numberPhone,
    name,
    availableCredits,
    file: 'lambda-chatbot.mjs'
  });

  if (availableCredits <= 0) {
    return DEFAULT_NO_CREDITS_MESSAGE;
  }

  const prompt = await generatePrompt(name, question, emailToken);
  logInfo('Prompt generado para consulta', {
    userId,
    numberPhone,
    name,
    promptPreview: truncateTextForLog(prompt),
    historyLength: history.length,
    question: truncateTextForLog(question),
    file: 'lambda-chatbot.mjs'
  });
  const classification = await classifyIntent(question);
  const modelSelected = classification?.requires_strong_model ? "gpt-4o" : "gpt-4.1-mini";
  const openAIMessages = buildChatCompletionMessages(prompt, history, question, imageBase64);

  logInfo('Modelo seleccionado para consulta', {
    userId,
    numberPhone,
    name,
    modelSelected,
    classification,
    hasImage: Boolean(imageBase64),
    messagesCount: openAIMessages.length,
    file: 'lambda-chatbot.mjs'
  });

  const response = await createOpenAIChatCompletion({
    model: modelSelected,
    messages: openAIMessages,
    temperature: 0,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0
  });

  const responseText = response.choices[0].message.content.replace(/\*\*/g, '*');
  const type = imageBase64 !== "" ? 'imagen' : '';

  logInfo('Respuesta de IA generada', {
    userId,
    numberPhone,
    name,
    modelSelected,
    hasImage: Boolean(imageBase64),
    responseText: truncateTextForLog(responseText),
    promptTokens: response.usage?.prompt_tokens ?? 0,
    completionTokens: response.usage?.completion_tokens ?? 0,
    totalTokens: response.usage?.total_tokens ?? 0,
    file: 'lambda-chatbot.mjs'
  });

  await postWhatsappConversation(phone, question, responseText, imageBase64, type, "", emailToken);
  await processTokenUsage(response, availableCredits, userId, numberPhone, name, emailToken);

  return responseText;
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST,OPTIONS"
};

const jsonResponse = (statusCode, payload) => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(payload)
});

const normalizeHistory = (history) => {
  if (!Array.isArray(history)) return [];

  return history
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      role: item.role === "assistant" ? "assistant" : "user",
      content: String(item.content ?? "").trim()
    }))
    .filter((item) => item.content !== "")
    .slice(-20);
};

const buildUpdatedHistory = (history, question, response) => {
  const newHistory = normalizeHistory(history);
  newHistory.push({ role: "user", content: question });
  newHistory.push({ role: "assistant", content: response });
  return newHistory.slice(-20);
};

const splitResponseChunks = (response) => (
  String(response || "")
    .split(/:\n\n|\n\n/)
    .map((chunk) => chunk.replace(/^[\n]+/, '').trim())
    .filter(Boolean)
);

const buildChunkResponse = (response) => {
  const messages = splitResponseChunks(response);
  return {
    reply: response,
    messages
  };
};

const hasOnlyEmoji = (str = "") => {
  const text = String(str).trim();
  const codePoints = [...text];

  if (codePoints.length !== 1) return false;

  const code = codePoints[0].codePointAt(0);
  return (
    (code >= 0x1F600 && code <= 0x1F64F) ||
    (code >= 0x1F300 && code <= 0x1F5FF) ||
    (code >= 0x1F680 && code <= 0x1F6FF) ||
    (code >= 0x1F1E6 && code <= 0x1F1FF) ||
    (code >= 0x2600 && code <= 0x26FF) ||
    (code >= 0x2700 && code <= 0x27BF) ||
    (code >= 0x1F900 && code <= 0x1F9FF) ||
    (code >= 0x1FA70 && code <= 0x1FAFF)
  );
};

const isGreeting = (text = "") => {
  const normalized = String(text).toLowerCase();
  const greetings = ['hola', 'como esta', 'buenos dias', 'buenas tardes', 'buenas noches'];
  return greetings.some((greeting) => normalized.includes(greeting));
};

const resolvePromptMediaUrl = (promptData) => {
  if (!promptData?.url_menu || promptData.url_menu === "NA") return "";
  return promptData.url_menu;
};

const processLambdaAlarm = async ({ phone, name, question, userOrIA, emailToken }) => {
  const hasAlarm = await regexAlarm(question, emailToken);

  logInfo('Verificación de alarma en lambda chatbot', {
    phone,
    name,
    messageBody: question,
    hasAlarm,
    userOrIA,
    action: 'lambda_alarm_check',
    file: 'lambda-chatbot.mjs'
  });

  if (!hasAlarm) {
    return {
      triggered: false,
      responseMessage: ""
    };
  }

  if (userOrIA === "user") {
    await postWhatsappConversation(phone, question, "", "", "", "", emailToken);
  }

  const alarmResponse = await putWhatsappEmailVendor(phone, name, question, "", emailToken);
  const message = userOrIA === "user"
    ? "Gracias por tu mensaje. En breve nos pondremos en contacto contigo."
    : question;

  const responseMessage = alarmResponse
    ? message
    : "Lo sentimos, pero no tenemos personal disponible en este momento.";

  await putWhatsapp(phone, name, false, emailToken);

  return {
    triggered: true,
    responseMessage,
    vendorNotified: Boolean(alarmResponse)
  };
};

const getRequestBody = (event) => {
  if (!event?.body) return {};
  if (typeof event.body === "string") return JSON.parse(event.body);
  return event.body;
};

export const handler = async (event) => {
  if (event?.httpMethod === "OPTIONS") {
    return jsonResponse(200, { ok: true });
  }

  try {
    const body = getRequestBody(event);
    const emailToken = String(body.email_token || body.emailToken || "").trim();
    const phone = String(body.phone || "").trim();
    setLogContext({ emailToken, phone });
    const name = String(body.name || "").trim();
    const inputQuestion = String(body.question || body.message || "").trim();
    const imageBase64 = String(body.imageBase64 || "");
    const audioBase64 = String(body.audioBase64 || body.oggBase64 || "").trim();

    logInfo('Solicitud recibida en lambda chatbot', {
      name,
      question: truncateTextForLog(inputQuestion),
      hasImage: imageBase64 !== "",
      hasAudio: audioBase64 !== "",
      bodyKeys: Object.keys(body || {}),
      file: 'lambda-chatbot.mjs'
    });

    let question = inputQuestion;
    let transcribedAudioText = "";

    if (audioBase64) {
      transcribedAudioText = await transcribeAudioBase64ToText(audioBase64, phone);
      question = transcribedAudioText;
    }

    if (!emailToken || !phone || !question) {
      logWarn('Solicitud inválida por campos requeridos faltantes', {
        name,
        hasEmailToken: Boolean(emailToken),
        hasPhone: Boolean(phone),
        hasQuestion: Boolean(question),
        hasAudio: Boolean(audioBase64),
        transcribedAudioText: truncateTextForLog(transcribedAudioText),
        file: 'lambda-chatbot.mjs'
      });
      return jsonResponse(400, {
        message: "email_token, phone y question son requeridos. Si envias audioBase64, la transcripcion debe generar texto."
      });
    }

    logInfo('Texto efectivo de consulta resuelto', {
      name,
      originalQuestion: truncateTextForLog(inputQuestion),
      transcribedAudioText: truncateTextForLog(transcribedAudioText),
      effectiveQuestion: truncateTextForLog(question),
      file: 'lambda-chatbot.mjs'
    });

    if (hasOnlyEmoji(question)) {
      logInfo('Solicitud omitida por contener solo emoji', {
        name,
        question: truncateTextForLog(question),
        file: 'lambda-chatbot.mjs'
      });
      return jsonResponse(200, {
        ok: true,
        skipped: true,
        reason: "emoji_only",
        phone
      });
    }

    const isWhitelisted = await getWhatsappWhitelist(phone, emailToken);
    if (isWhitelisted) {
      logInfo('Solicitud omitida por whitelist', {
        name,
        question: truncateTextForLog(question),
        file: 'lambda-chatbot.mjs'
      });
      return jsonResponse(200, {
        ok: true,
        skipped: true,
        reason: "whitelist",
        phone
      });
    }

    const botStatus = await whatsappStatus(emailToken);
    if (botStatus && !botStatus.status) {
      await postWhatsappConversation(phone, question, "", "", "", "", emailToken);
      logWarn('Solicitud omitida porque el bot está deshabilitado', {
        name,
        botStatus,
        question: truncateTextForLog(question),
        file: 'lambda-chatbot.mjs'
      });
      return jsonResponse(200, {
        ok: true,
        skipped: true,
        reason: "bot_disabled",
        phone
      });
    }

    const userStatus = await getWhatsapp(phone, emailToken);
    if (!userStatus) {
      await putWhatsapp(phone, name, true, emailToken);
      logInfo('Sesión de usuario creada en lambda chatbot', {
        name,
        file: 'lambda-chatbot.mjs'
      });
    }

    if (userStatus && !userStatus.status) {
      await postWhatsappConversation(phone, question, "", "", "", "", emailToken);
      logWarn('Solicitud omitida porque el usuario está deshabilitado', {
        name,
        question: truncateTextForLog(question),
        userStatus,
        file: 'lambda-chatbot.mjs'
      });
      return jsonResponse(200, {
        ok: true,
        skipped: true,
        reason: "user_disabled",
        phone
      });
    }

    const userAlarm = await processLambdaAlarm({
      phone,
      name,
      question,
      userOrIA: "user",
      emailToken
    });

    if (userAlarm.triggered) {
      const fragmentedAlarmResponse = buildChunkResponse(userAlarm.responseMessage);
      logInfo('Respuesta por alarma de usuario', {
        name,
        responseText: truncateTextForLog(userAlarm.responseMessage),
        vendorNotified: userAlarm.vendorNotified ?? false,
        file: 'lambda-chatbot.mjs'
      });
      return jsonResponse(200, {
        ok: true,
        phone,
        name,
        question,
        transcribedAudioText,
        ...fragmentedAlarmResponse,
        alarmTriggered: true,
        vendorNotified: userAlarm.vendorNotified ?? false,
        history: buildUpdatedHistory([], question, userAlarm.responseMessage)
      });
    }

    const persistedHistory = normalizeHistory(await getWhatsappConversation(phone, emailToken));

    logInfo('Historial de conversación recuperado en lambda desde la base de datos', {
      phone,
      name,
      historyLength: persistedHistory.length,
      historyPreview: persistedHistory.map((item) => ({
        role: item.role,
        content: truncateTextForLog(item.content, 300)
      })),
      action: 'lambda_history_db_retrieved',
      file: 'lambda-chatbot.mjs'
    });

    const modelHistory = [...persistedHistory, { role: "user", content: question }];
    const rawResponse = await runChatbot(name, modelHistory, question, phone, imageBase64, emailToken);

    let finalResponse = rawResponse;
    let alarmTriggered = false;
    let vendorNotified = false;

    const iaAlarm = await processLambdaAlarm({
      phone,
      name,
      question: rawResponse,
      userOrIA: "IA",
      emailToken
    });

    if (iaAlarm.triggered) {
      finalResponse = iaAlarm.responseMessage;
      alarmTriggered = true;
      vendorNotified = iaAlarm.vendorNotified ?? false;
      logInfo('Respuesta reemplazada por alarma de IA', {
        name,
        responseText: truncateTextForLog(finalResponse),
        vendorNotified,
        file: 'lambda-chatbot.mjs'
      });
    }

    let orderProcessed = false;
    if (rawResponse.toLowerCase().includes("datos recibidos")) {
      const whatsappPrompt = await promptGetWhatsapp(question, emailToken);

      if (whatsappPrompt?.products_dynamic) {
        const updatePrompt = await runUpdatePromptServicesProduct(rawResponse, emailToken);
        await promptUpdateProductWhatsapp(updatePrompt, emailToken);
      }

      await putWhatsappOrderConfirmation(name, phone, rawResponse, "pending_payment", emailToken);
      await putWhatsapp(phone, name, false, emailToken);
      orderProcessed = true;
    }

    let mediaUrl = "";
    if (isGreeting(question)) {
      const whatsappPrompt = await promptGetWhatsapp(question.toLowerCase().trim(), emailToken);
      mediaUrl = resolvePromptMediaUrl(whatsappPrompt);
    }

    const fragmentedResponse = buildChunkResponse(finalResponse);

    logInfo('Respuesta final de lambda chatbot', {
      name,
      responseText: truncateTextForLog(finalResponse),
      messagesCount: fragmentedResponse.messages.length,
      messagesPreview: fragmentedResponse.messages.map((item) => truncateTextForLog(item, 300)),
      mediaUrl,
      alarmTriggered,
      vendorNotified,
      orderProcessed,
      file: 'lambda-chatbot.mjs'
    });

    return jsonResponse(200, {
      ok: true,
      phone,
      name,
      question,
      transcribedAudioText,
      ...fragmentedResponse,
      mediaUrl,
      alarmTriggered,
      vendorNotified,
      orderProcessed,
      history: buildUpdatedHistory(persistedHistory, question, finalResponse)
    });
  } catch (error) {
    logError('Error en lambda chatbot', {
      error: error.message,
      stack: error.stack,
      action: 'lambda_chatbot_error',
      file: 'lambda-chatbot.mjs'
    });

    return jsonResponse(500, {
      message: 'Error procesando mensaje en lambda chatbot',
      error: error.message
    });
  }
};
