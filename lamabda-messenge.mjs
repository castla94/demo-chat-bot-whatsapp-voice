import {
  DynamoDBClient,
  QueryCommand,
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const clientLambda = new LambdaClient({ region: "us-east-1" });

const dynamo = new DynamoDBClient({});

const TABLE_NAME = process.env.TABLE_NAME;
const TABLE_NAME_CHAT = process.env.TABLE_NAME_CHAT;
const TABLE_NAME_SESSIONES = process.env.TABLE_NAME_SESSIONES;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TABLE_NAME_SETTING = process.env.TABLE_NAME_SETTING;

const BASE_URL = "https://c0jkurvt19.execute-api.us-east-1.amazonaws.com/DEV";

const normalizeUrlBase = (value) => String(value || "").trim().replace(/\/+$/, "");

const extractDate = (message) => {
  const regex = /\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})\b/;
  const match = String(message || "").match(regex);

  if (!match) {
    return null;
  }

  let [, day, month, year] = match;
  day = day.padStart(2, "0");
  month = month.padStart(2, "0");

  if (year.length === 2) {
    year = `20${year}`;
  }

  const date = new Date(Number(year), Number(month) - 1, Number(day));
  const valid =
    date.getFullYear() === Number(year) &&
    date.getMonth() === Number(month) - 1 &&
    date.getDate() === Number(day);

  if (!valid) {
    return null;
  }

  return {
    original: match[0],
    display: `${day}-${month}-${year}`,
    iso: `${year}-${month}-${day}`
  };
};

const resolveOpenAIQuestion = (requires_strong_model, question) => {
  if (!requires_strong_model) {
    return {
      finalQuestion: question,
      dateExtracted: null,
      dateApplied: false
    };
  }

  const dateExtracted = extractDate(question);
  const finalQuestion = dateExtracted ? dateExtracted.display : question;

  return {
    finalQuestion,
    dateExtracted,
    dateApplied: Boolean(dateExtracted)
  };
};

const resolveModelSelection = async (question) => {
  const classification = await classifyIntent(question || "");
  const modelSelected = "gpt-5-mini";

  return {
    modelSelected,
    classification,
    classificationEnabled: true
  };
};

export const getWhatsappCredit = async (email_bk) => {
  const base = normalizeUrlBase(process.env.BASE_URL || process.env.PROMPT_BASE_URL || BASE_URL);
  const emailValue = String(email_bk || "").trim().toLowerCase();
  if (!base || !emailValue) return null;
  const endpoint = `${base}/whatsapp-setting/credits?email_bk=${encodeURIComponent(emailValue)}`;
  try {
    const response = await global.fetch(endpoint, { method: "GET" });
    const data = await response.json().catch(() => null);
    const rawCredit = data?.item?.credit;
    const credit = typeof rawCredit === "number" ? rawCredit : typeof rawCredit === "string" ? Number(rawCredit) : NaN;
    return Number.isFinite(credit) ? credit : null;
  } catch (error) {
    console.error("get_whatsapp_credit_error", error);
    return null;
  }
};

export const postWhatsappCredit = async (email_bk, credit) => {
  const base = normalizeUrlBase(process.env.BASE_URL || process.env.PROMPT_BASE_URL || BASE_URL);
  const emailValue = String(email_bk || "").trim().toLowerCase();
  if (!base || !emailValue) return null;
  const endpoint = `${base}/whatsapp-setting/credits?email_bk=${encodeURIComponent(emailValue)}`;
  try {
    const response = await global.fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credit: String(credit) })
    });
    const data = await response.json().catch(() => null);
    return data;
  } catch (error) {
    console.error("post_whatsapp_credit_error", error);
    return null;
  }
};


const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))


export const handler = async (event) => {
  try {
    for (const record of event.Records) {
      const { sender_id,accountID } = JSON.parse(record.body);
      console.log("record.body: ",JSON.parse(record.body))

      let settingMessenger = null;
      let items = [];

      try {
        settingMessenger = await findMessenger(accountID)

        console.log("settingMessenger:",settingMessenger)
        console.log(`▶️ Procesando conversación completa de ${sender_id} - ${settingMessenger?.email || ""}`);

        // 1️⃣ Obtener todos los mensajes de este usuario desde DynamoDB
        const query = await dynamo.send(
          new QueryCommand({
            TableName: TABLE_NAME,
            KeyConditionExpression: "senderId = :sid",
            ExpressionAttributeValues: { ":sid": { S: sender_id } },
          })
        );

        items = query.Items || [];

        const availableCredit = await getWhatsappCredit(settingMessenger?.email);
        if (!Number.isFinite(availableCredit) || availableCredit <= 0) {
          console.log(`Créditos insuficientes, ignorando procesamiento de ${sender_id} - ${settingMessenger?.email || ""}`);
          continue;
        }

        if (items.length === 0) {
          console.log(`No hay mensajes para ${sender_id} } - ${settingMessenger.email}`);
          continue;
        }

        // 2️⃣ Combinar los mensajes en una sola cadena (contexto completo)
        const fullContext = items
          .sort((a, b) => Number(a.timestamp.N) - Number(b.timestamp.N))
          .map((msg) => msg.text.S)
          .join("\n");

        const regexAlarmUser = await regexAlarm(fullContext,settingMessenger.email)
        if(regexAlarmUser){
          console.log(`Alarma de mensaje de usuario ${sender_id} - ${settingMessenger.email} activada con mensaje :\n${fullContext}`)
          await updateMessengerUserStatus(settingMessenger.email, sender_id, false)
          await putMessengerEmailVendor(sender_id, "Usuario#"+sender_id, fullContext, "",settingMessenger.email)
        }

        console.log(`📄 Contexto combinado (${items.length} mensajes):\n${fullContext}`);

        const prompt = await getPromptLambda(settingMessenger.email,fullContext)

        // 1️⃣ Obtener histórico
        const history = await getChatHistory(sender_id,settingMessenger.email);

        // 2️⃣ Generar respuesta IA
        const reply = await getOpenAIResponse(prompt, history, fullContext );

        const nextCredit = availableCredit - 1;
        await postWhatsappCredit(settingMessenger.email, nextCredit);


        const regexAlarmOpenia = await regexAlarm(reply,settingMessenger.email)
        if(regexAlarmOpenia){
          console.log(`Alarma de mensaje de usuario ${sender_id} - ${settingMessenger.email} activada con mensaje :\n${reply}`)
          await updateMessengerUserStatus(settingMessenger.email, sender_id, false)
          await putMessengerEmailVendor(sender_id, "Usuario#"+sender_id, "Ultimo mensaje usuario :\n"+fullContext+"\n respuesta IA :"+reply, "",settingMessenger.email)
        }

        if (reply.toLowerCase().includes("datos recibidos") && !regexAlarmOpenia && !regexAlarmUser) {
          console.log(`Notificacion ${sender_id} - ${settingMessenger.email} activada con mensaje :\n${fullContext}`)
          await updateMessengerUserStatus(settingMessenger.email, sender_id, false)
          await putMessengerEmailVendor(sender_id, "Usuario#"+sender_id, "Ultimo mensaje usuario :\n"+fullContext+"\n respuesta IA :"+reply, "",settingMessenger.email)
          try {
            const analyzedMessage = await runAnalyzeText("Ultimo mensaje usuario :\n"+fullContext+"\n respuesta IA :"+reply);
            const MessengerUser = await getMessengerUser(settingMessenger.email, sender_id).catch(() => undefined);
            await putMessengerOrder(
              settingMessenger.email,
              sender_id,
              analyzedMessage,
              MessengerUser?.name || "",
              MessengerUser?.username || ""
            );
          } catch (error) {
            console.error("Messenger_order_creation_error", {
              email: settingMessenger.email,
              sender_id,
              message: error?.message || ""
            });
          }
        }

        // 3️⃣ Guardar conversación
        await saveConversation(sender_id, fullContext, reply,settingMessenger.email);

        // Guardar sesion
        await upsertMessengerUser(settingMessenger.email, sender_id, "Usuario#"+sender_id,true)
        await updateMessengerUserProfileIfMissing(settingMessenger.email, sender_id, settingMessenger.token)

        await updateTimestampMessengerUser(settingMessenger.email, sender_id)


        const chunksReply = reply.split(/:\n\n|\n\n/)

        // 4️⃣ Enviar respuesta al usuario de Messenger

        await sendMessengerMessage({
          pageId: settingMessenger.senderId,
          recipientId: sender_id,
          text: reply,
          pageAccessToken: settingMessenger.token
        });
/*
        for (const chunk of chunksReply) {
          await sendMessengerMessage({
            pageId: settingMessenger.senderId,
            recipientId: sender_id,
            text: chunk.replace(/^[\n]+/, '').trim(),
            pageAccessToken: settingMessenger.token
          });
          await sleep(2000)
        }*/
        console.log(`📤 Respuesta enviada ${sender_id} } - ${settingMessenger.email} : ${reply}`);

        await deleteQueuedMessages(items, sender_id, settingMessenger.email);
      } catch (recordError) {
        console.error(`❌ Error controlado procesando ${sender_id} - ${settingMessenger?.email || ""}:`, recordError);
        await deleteQueuedMessages(items, sender_id, settingMessenger?.email || "");
      }
    }

    return { statusCode: 200, body: "Messages processed" };
  } catch (err) {
    console.error(`❌ Error  en messageProcessor:`, err);
    return { statusCode: 200, body: "Messages processed" };

  }
};

async function deleteQueuedMessages(items, senderId, email = "") {
  if (!Array.isArray(items) || items.length === 0) {
    console.log(`No hay mensajes pendientes para eliminar de ${senderId} ${email ? `- ${email}` : ""}`);
    return;
  }

  for (const msg of items) {
    await dynamo.send(
      new DeleteItemCommand({
        TableName: TABLE_NAME,
        Key: {
          senderId: msg.senderId,
          timestamp: msg.timestamp,
        },
      })
    );
  }

  console.log(`🧹 Mensajes de ${senderId} } - ${email} eliminados`);
}



export const putMessengerEmailVendor = async (senderId, name, message, image = "",email_token) => {
  const endpoint = `${BASE_URL}/messenger-email-vendor`;

  console.log("Request putMessengerEmailVendor ",{
        senderId,
        email_token,
        name,
        message,
        image
      })
  try {
    const response = await global.fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        senderId,
        email_token,
        name,
        message,
        image
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP error!: ${response}`);
    }
    const data = await response.json();
    console.log("putMessengerEmailVendor.response:",data)
    return data.statusCode === 200;
  } catch (error) {
    console.error('Error enviando notificación al vendedor', error);
    return false;
  }
};

export const runAnalyzeText = async (text) => {
  const payload = {
    model: "gpt-4.1-mini",
    messages: [
      {
        role: "system",
        content: "Analiza el texto del mensaje y devuelve solo los datos clave capturados del usuario en formato clave: valor. No agregues explicación, markdown ni texto adicional."
      },
      {
        role: "user",
        content: String(text || "")
      }
    ],
    temperature: 0
  };

  const response = await global.fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    console.error("runAnalyzeText.error", {
      status: response.status,
      data
    });
    throw new Error(data?.error?.message || "Error analizando texto con OpenAI");
  }

  return String(data?.choices?.[0]?.message?.content || "").trim();
};

async function putMessengerOrder(email, senderId, message, name = "", username = "") {
  const timestamp = Date.now();
  const orderId = `${String(senderId || "").trim()}${timestamp}`;

  try {
    const command = new PutItemCommand({
      TableName: "messenger_orders",
      Item: {
        email: { S: String(email || "").trim() },
        senderId: { S: String(senderId || "").trim() },
        name: { S: String(name || "").trim() },
        username: { S: String(username || "").trim() },
        message: { S: String(message || "").trim() },
        timestamp: { N: String(timestamp) },
        orderId: { S: orderId }
      }
    });

    await dynamo.send(command);
    console.log("putMessengerOrder.success", {
      email,
      senderId,
      orderId
    });
    return true;
  } catch (error) {
    console.error("putMessengerOrder.error", {
      email,
      senderId,
      message: error?.message || ""
    });
    throw error;
  }
}

export const generateExpirateDate =  (expirateDate) => {
  const ttlInHours = expirateDate;
  const ttlInSecounds = ttlInHours * 60 * 60;
  const expirateTime = Math.floor(Date.now()/1000) + ttlInSecounds;
  return  expirateTime.toString();
}


// 🔹 Guardar conversación en DynamoDB
async function saveConversation(senderId, userMessage, aiReply,email) {
  const now = new Date().toISOString();
  const expire = generateExpirateDate(720);

  const type =""
  const imageBase64 = undefined
  const type_user = undefined
  const keyResultS3 = ""
  
  try { 
    const chat = new PutItemCommand({
      TableName: TABLE_NAME_CHAT,
      Item: {
        senderId: { S: senderId },
        email: { S: email },
        timestamp: { S: now },
        expire: { N: expire },
        message_user: { S: userMessage },
        message_openia: { S: aiReply },
        type_user:{ S: type_user === undefined ? "" : type_user },
        imageBase64: { S: imageBase64 === undefined ? "" : keyResultS3 },
        typeMedia: { S: type === undefined ? "" : type },
      },
    });

    await dynamo.send(chat);
  } catch (err) {
    console.error("⚠️ Error guardando conversación:", err);
  }
}


async function classifyIntent(question) {
  const apiKey = process.env.OPENAI_API_KEY;
  console.log("classifyIntent question: ",question)

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
Si pregunta por disponibilidad, horarios , agenda , envia una fecha usa 'availability'. 
Si quiere reservar, agendar usa 'reservation'. 
Si no calza claramente, usa 'other'.
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
    return JSON.parse(rawText || "{}");
  } catch {
    const normalizedText = rawText
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    const jsonMatch = normalizedText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (error) {
        console.log("classifyIntent.parse_error", {
          message: error?.message || "",
          rawText
        });
      }
    }

    return {
      intent: "availability",
      requires_strong_model: false
    };
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



// 🔹 Obtener respuesta desde OpenAI
async function getOpenAIResponse(prompt, history, message ) {
    const { modelSelected, classification, classificationEnabled } = await resolveModelSelection(message || "");
    const { finalQuestion, dateExtracted, dateApplied } = resolveOpenAIQuestion(classification?.requires_strong_model, message || "");

    const historyForOpenAI = [...(history || [])];
    const lastUserEntry = [...historyForOpenAI].map((item, idx) => ({ item, idx })).reverse().find((entry) => entry?.item?.role === "user");
    const lastUserIndex = lastUserEntry?.idx ?? -1;

    if (lastUserIndex >= 0) {
      historyForOpenAI[lastUserIndex] = {
        ...(historyForOpenAI[lastUserIndex] || {}),
        role: "user",
        content: finalQuestion
      };
    } else {
      historyForOpenAI.push({
        role: "user",
        content: finalQuestion
      });
    }

    console.log("modelSelected:",modelSelected);
    console.log("resolveOpenAIQuestion applied:", {
      originalMessage: message,
      finalQuestion,
      dateExtracted,
      dateApplied,
      lastUserIndex,
      classificationEnabled,
      classification
    });

  const res = await global.fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelSelected,
      ...(modelSelected === "gpt-5-mini" ? { reasoning_effort: "low" } : {}),
      messages: [ { "role": "developer", "content": prompt }, ...historyForOpenAI],
      ...(modelSelected === "gpt-5-mini" ? {} : { temperature: 0 }),
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    }),
  });
  
  console.log("OpenIA Request ",[ { "role": "system", "content": prompt }, ...historyForOpenAI])

  const data = await res.json();
  if (!res.ok) {
    console.error("❌ Error OpenAI:", data);
    throw new Error(data.error?.message || "Error en la solicitud a OpenAI");
  }

  return data.choices?.[0]?.message?.content?.trim() || "No tengo respuesta por ahora.";
}




/**
 * Envía un mensaje de texto por Facebook Messenger.
 *
 * @param {Object} params
 * @param {string} params.pageId ID de la página de Facebook.
 * @param {string} params.recipientId PSID del usuario: sender.id del webhook.
 * @param {string} params.text Texto que se enviará.
 * @param {string} params.pageAccessToken Token de acceso de la página.
 */
async function sendMessengerMessage({
  pageId,
  recipientId,
  text,
  pageAccessToken
}) {
  if (!pageId || !recipientId || !text || !pageAccessToken) {
    throw new Error("pageId, recipientId, text y pageAccessToken son obligatorios");
  }

  const url = new URL(`https://graph.facebook.com/v25.0/${pageId}/messages`);
  url.searchParams.set("access_token", pageAccessToken);

  const response = await global.fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      recipient: {
        id: recipientId
      },
      messaging_type: "RESPONSE",
      message: {
        text
      }
    })
  });

  const result = await response.json().catch(() => null);

  if (!response.ok) {
    console.error("Error enviando mensaje:", result);
    throw new Error(
      result?.error?.message ??
      "No se pudo enviar el mensaje por Messenger"
    );
  }

  console.log("Mensaje enviado:", result);

  return result;
}



/**
 * Busca un registro en DynamoDB por PK y coincidencia parcial en email_senderId
 * @param {string} partialSender - Texto parcial a buscar en email_senderId
 * @returns {Promise<Object|null>} - Retorna el primer item encontrado o null
 */
export async function findMessenger(accountID) {
  if (!accountID) throw new Error("Falta parámetro accountID");

  const command = new GetItemCommand({
    TableName: TABLE_NAME_SETTING,
    Key: {
      PK: { S: "MESSENGER" },
      senderId: { S: accountID },
    },
  });

  const response = await dynamo.send(command);

  if (!response.Item) return null;

  return unmarshall(response.Item);
}


async function getPromptLambda(email,question) {
  try {
    const params = {
      FunctionName: "arn:aws:lambda:us-east-1:967208159246:function:prompt-whatsapp", // nombre o ARN de Lambda B
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify({
    body: JSON.stringify({ email }),
  })),
    }; 

    const command = new InvokeCommand(params);
    const response = await clientLambda.send(command);

    // response.Payload es un Uint8Array -> hay que transformarlo
    const payloadString = Buffer.from(response.Payload).toString("utf8");
    console.log(payloadString)
    const result = JSON.parse(payloadString);
    const resultbody = JSON.parse(result.body);
    let prompt = resultbody.prompt.replaceAll("{question}", "");
     prompt = prompt.replaceAll("Consulta del Cliente:", "");

    console.log("Respuesta desde getPromptLambda:", prompt);

    return prompt; // Devuelve la respuesta de Lambda B como objeto JSON pars
  } catch (error) {
    console.error("Error al invocar getPromptLambda", error);
    throw new Error(error.error?.message || "Error obteniendo el prompt");
  }
}



// 🔹 Obtener los últimos 20 mensajes del historial
async function getChatHistory(senderId,email) {
  try {
    const res = await dynamo.send(
      new QueryCommand({
    TableName: TABLE_NAME_CHAT,
    KeyConditionExpression: "senderId = :senderId",
    FilterExpression: "email = :email",
    ExpressionAttributeValues: {
      ":senderId": { S: senderId },
      ":email": { S: email }
    },
    canIndexForward: true, // Más recientes primero
    Limit: 20,
  })
    );
    
    let history = [];
     res.Items?.forEach(item => {
          history.push({
              role: 'user',
              content: item.message_user.S
          });
          history.push({
            role: 'assistant',
            content: item.message_openia.S
          });
    });
    
    console.log("Respuesta desde getChatHistory:", history);

    return history
    
  } catch (err) {
    console.error("⚠️ Error obteniendo historial:", err);
    return [];
  }
}


export async function getMessengerUser(email, senderId) {
  try {
    const { Item } = await dynamo.send(
      new GetItemCommand({
        TableName: TABLE_NAME_SESSIONES,
        Key: { 
          email: { S: email },
          senderId: { S: senderId } 
        },
      })
    );
    return Item ? unmarshall(Item) : undefined;
  } catch (err) {
    console.error("❌ Error al obtener usuario:", err);
    throw err;
  }
}

export async function putMessengerUser(email, senderId, name, status = true) {
  try {
    const timestamp = new Date().toISOString();

    await dynamo.send(
      new PutItemCommand({
        TableName: TABLE_NAME_SESSIONES,
        Item: {
          email: { S: email },
          senderId: { S: senderId },
          name: { S: name },
          status: { BOOL: status },
          reminder: { S: "0" },
          tag_name: { S: "Nuevo" },
          funnel_step: { S: "Inicio" },
          last_message: { S: "" },
          timestamp: { S: timestamp },
        }
      })
    );

  } catch (err) {
    console.error("❌ Error al crear usuario:", err);
  }
}

export async function updateTimestampMessengerUser(email, senderId) {
  try {
    const timestamp = new Date().toISOString();

    await dynamo.send(
      new UpdateItemCommand({
        TableName: TABLE_NAME_SESSIONES,
        Key: {
          email: { S: email },
          senderId: { S: senderId }
        },
        UpdateExpression: "SET #ts = :timestamp",
        ExpressionAttributeNames: {
          "#ts": "timestamp"
        },
        ExpressionAttributeValues: {
          ":timestamp": { S: timestamp }
        }
      })
    );

  } catch (err) {
    console.error("❌ Error al actualizar timestamp :", err);
  }
}

export async function updateMessengerUserStatus(email, senderId, status) {
  try {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: TABLE_NAME_SESSIONES,
        Key: {
          email: { S: email },
          senderId: { S: senderId }
        },
        UpdateExpression: "SET #status = :status",
        ExpressionAttributeNames: {
          "#status": "status"
        },
        ExpressionAttributeValues: {
          ":status": { BOOL: Boolean(status) }
        }
      })
    );
  } catch (err) {
    console.error("❌ Error al actualizar status :", err);
  }
}

export async function obtenerPerfilMessenger(
  psid,
  pageAccessToken
) {
  if (!psid) {
    throw new Error("El PSID de Messenger es obligatorio");
  }

  if (!pageAccessToken) {
    throw new Error("El Page Access Token es obligatorio");
  }

  const url = new URL(
    `https://graph.facebook.com/v25.0/${encodeURIComponent(psid)}`
  );

  url.searchParams.set(
    "fields",
    "id,name,first_name,last_name,profile_pic"
  );

  const response = await global.fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${pageAccessToken}`,
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(10000)
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    console.error("Error obteniendo perfil de Messenger:", {
      status: response.status,
      error: data?.error
    });

    throw new Error(
      data?.error?.message ||
      `No se pudo obtener el perfil de Messenger (${response.status})`
    );
  }

  return data ?? {};
}

export async function updateMessengerUserProfileIfMissing(email, senderId, accessToken) {
  try {
    const existing = await getMessengerUser(email, senderId);
    if (!existing) {
      console.log("updateMessengerUserProfileIfMissing.skip_no_user", { email, senderId });
      return;
    }

    const hasName = Boolean(String(existing?.name || "").trim()) && !String(existing?.name || "").startsWith("Usuario#");
    const hasUsername = Boolean(String(existing?.username || "").trim());
    const hasProfilePic = Boolean(String(existing?.profile_pic || "").trim());

    if (hasName && hasUsername && hasProfilePic) {
      console.log("updateMessengerUserProfileIfMissing.skip_complete", { email, senderId });
      return;
    }

    const profile = await obtenerPerfilMessenger(senderId, accessToken);
    console.log("updateMessengerUserProfileIfMissing.profile", profile);

    const updateParts = [];
    const expressionAttributeNames = {};
    const expressionAttributeValues = {};

    if (!hasName && String(profile?.name || "").trim()) {
      updateParts.push("#name = :name");
      expressionAttributeNames["#name"] = "name";
      expressionAttributeValues[":name"] = { S: String(profile.name).trim() };
    }

    if (!hasUsername && String(profile?.username || "").trim()) {
      updateParts.push("#username = :username");
      expressionAttributeNames["#username"] = "username";
      expressionAttributeValues[":username"] = { S: String(profile.username).trim() };
    }

    if (!hasProfilePic && String(profile?.profile_pic || "").trim()) {
      updateParts.push("#profile_pic = :profile_pic");
      expressionAttributeNames["#profile_pic"] = "profile_pic";
      expressionAttributeValues[":profile_pic"] = { S: String(profile.profile_pic).trim() };
    }

    if (!updateParts.length) {
      console.log("updateMessengerUserProfileIfMissing.skip_no_updates", { email, senderId });
      return;
    }

    await dynamo.send(
      new UpdateItemCommand({
        TableName: TABLE_NAME_SESSIONES,
        Key: {
          email: { S: email },
          senderId: { S: senderId }
        },
        UpdateExpression: `SET ${updateParts.join(", ")}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues
      })
    );

    console.log("updateMessengerUserProfileIfMissing.success", {
      email,
      senderId,
      updatedFields: Object.keys(expressionAttributeNames).map((key) => expressionAttributeNames[key])
    });
  } catch (err) {
    console.error("❌ Error al actualizar perfil de Messenger:", err);
  }
}

export async function upsertMessengerUser(email, senderId, name, status = true) {
  try {
    // 🔹 1️⃣ Buscar si el registro ya existe
    const existing = await getMessengerUser(email, senderId);

    if (!existing) {
      // 🔹 2️⃣ Crear el nuevo registro
      await putMessengerUser(email, senderId, name, status);
          console.log(`✅ Nuevo usuario creado: ${email}`);
    }

  } catch (err) {
    console.error("❌ Error al crear usuario:", err);
  }
}


export const regexAlarm = async (message,email_token) => {
  const endpoint = `${BASE_URL}/whatsapp-sessions-alarm/regex`;

  try {
    const response = await global.fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email_token,
        message
      })
    });

    const data = await response.json();
    return data.statusCode === 200;
  } catch (error) {
    console.error('Error verificando regexAlarm', error);
    return false;
  }
};
