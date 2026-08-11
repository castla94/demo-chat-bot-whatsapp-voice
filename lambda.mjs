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
let PAGE_ACCESS_TOKEN = ""; // token de página (no el user access token)
const TABLE_NAME_SETTING = process.env.TABLE_NAME_SETTING;

const BASE_URL = "https://c0jkurvt19.execute-api.us-east-1.amazonaws.com/DEV";

const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";

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

  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day)
  );

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

const resolveOpenAIQuestion = (modelSelected, question) => {
  if (modelSelected !== "gpt-4o") {
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
  const modelSelected = classification?.requires_strong_model ? "gpt-4o" : DEFAULT_OPENAI_MODEL;

  return {
    modelSelected,
    classification,
    classificationEnabled: true
  };
};

const normalizeUrlBase = (value) => String(value || "").trim().replace(/\/+$/, "");

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
      let settingInstagram = null;
      let items = [];

      try {
        const query = await dynamo.send(
          new QueryCommand({
            TableName: TABLE_NAME,
            KeyConditionExpression: "senderId = :sid",
            ExpressionAttributeValues: { ":sid": { S: sender_id } },
          })
        );

        items = query.Items || [];
        settingInstagram = await findInstagram(accountID);

        console.log(`▶️ Procesando conversación completa de ${sender_id} - ${settingInstagram?.email || ""}`);

        const availableCredit = await getWhatsappCredit(settingInstagram?.email);
        if (!Number.isFinite(availableCredit) || availableCredit <= 0) {
          console.log(`Créditos insuficientes, ignorando procesamiento de ${sender_id} - ${settingInstagram?.email || ""}`);
          continue;
        }

        PAGE_ACCESS_TOKEN = settingInstagram.token

        if (items.length === 0) {
          console.log(`No hay mensajes para ${sender_id} } - ${settingInstagram.email}`);
          continue;
        }

        // 2️⃣ Combinar los mensajes en una sola cadena (contexto completo)
        const fullContext = items
          .sort((a, b) => Number(a.timestamp.N) - Number(b.timestamp.N))
          .map((msg) => msg.text.S)
          .join("\n");

        const regexAlarmUser = await regexAlarm(fullContext,settingInstagram.email)
        if(regexAlarmUser){
          console.log(`Alarma de mensaje de usuario ${sender_id} - ${settingInstagram.email} activada con mensaje :\n${fullContext}`)
          await updateInstagramUserStatus(settingInstagram.email, sender_id, false)
          await putInstagramEmailVendor(sender_id, "Usuario#"+sender_id, fullContext, "",settingInstagram.email)
        }

        console.log(`📄 Contexto combinado (${items.length} mensajes):\n${fullContext}`);

        const prompt = await getPromptLambda(settingInstagram.email,fullContext)

        // 1️⃣ Obtener histórico
        const history = await getChatHistory(sender_id,settingInstagram.email);

        // 2️⃣ Generar respuesta IA
        const reply = await getOpenAIResponse(prompt, history, fullContext );

        const nextCredit = availableCredit - 1;
        await postWhatsappCredit(settingInstagram.email, nextCredit);


        const regexAlarmOpenia = await regexAlarm(reply,settingInstagram.email)
        if(regexAlarmOpenia){
          console.log(`Alarma de mensaje de usuario ${sender_id} - ${settingInstagram.email} activada con mensaje :\n${reply}`)
          await updateInstagramUserStatus(settingInstagram.email, sender_id, false)
          await putInstagramEmailVendor(sender_id, "Usuario#"+sender_id, "Ultimo mensaje usuario :\n"+fullContext+"\n respuesta IA :"+reply, "",settingInstagram.email)
        }

        if (reply.toLowerCase().includes("datos recibidos") && !regexAlarmOpenia && !regexAlarmUser) {
          console.log(`Notificacion ${sender_id} - ${settingInstagram.email} activada con mensaje :\n${fullContext}`)
          await updateInstagramUserStatus(settingInstagram.email, sender_id, false)
          await putInstagramEmailVendor(sender_id, "Usuario#"+sender_id, "Ultimo mensaje usuario :\n"+fullContext+"\n respuesta IA :"+reply, "",settingInstagram.email)
          try {
            const analyzedMessage = await runAnalyzeText("Ultimo mensaje usuario :\n"+fullContext+"\n respuesta IA :"+reply);
            const instagramUser = await getInstagramUser(settingInstagram.email, sender_id).catch(() => undefined);
            await putInstagramOrder(
              settingInstagram.email,
              sender_id,
              analyzedMessage,
              instagramUser?.name || "",
              instagramUser?.username || ""
            );
          } catch (error) {
            console.error("instagram_order_creation_error", {
              email: settingInstagram.email,
              sender_id,
              message: error?.message || ""
            });
          }
        }

        // 3️⃣ Guardar conversación
        await saveConversation(sender_id, fullContext, reply,settingInstagram.email);

        // Guardar sesion
        await upsertInstagramUser(settingInstagram.email, sender_id, "Usuario#"+sender_id,true)
        await updateInstagramUserProfileIfMissing(settingInstagram.email, sender_id, PAGE_ACCESS_TOKEN)

        await updateTimestampInstagramUser(settingInstagram.email, sender_id)


        const chunksReply = reply.split(/:\n\n|\n\n/)

        // 4️⃣ Enviar respuesta al usuario de Instagram

        for (const chunk of chunksReply) {
          await sendInstagramMessage(sender_id, chunk.replace(/^[\n]+/, '').trim());
          await sleep(2000)
        }
        console.log(`📤 Respuesta enviada ${sender_id} } - ${settingInstagram.email} : ${reply}`);

        await deleteQueueMessages(items, sender_id, settingInstagram.email);
      } catch (recordError) {
        console.error(`❌ Error controlado procesando ${sender_id} - ${settingInstagram?.email || ""}:`, recordError);
        await deleteQueueMessages(items, sender_id, settingInstagram?.email || "");
      }
    }

    return { statusCode: 200, body: "Messages processed" };
  } catch (err) {
    console.error(`❌ Error  en messageProcessor:`, err);
    return { statusCode: 200, body: "Messages processed" };

  }
};

async function deleteQueueMessages(items, senderId, email = "") {
  if (!Array.isArray(items) || items.length === 0) {
    console.log(`No hay mensajes en cola para eliminar de ${senderId} ${email ? `- ${email}` : ""}`);
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



export const putInstagramEmailVendor = async (senderId, name, message, image = "",email_token) => {
  const endpoint = `${BASE_URL}/instagram-email-vendor`;

  console.log("Request putInstagramEmailVendor ",{
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
    console.log("putInstagramEmailVendor.response:",data)
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

async function putInstagramOrder(email, senderId, message, name = "", username = "") {
  const timestamp = Date.now();
  const orderId = `${String(senderId || "").trim()}${timestamp}`;

  try {
    const command = new PutItemCommand({
      TableName: "instagram_orders",
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
    console.log("putInstagramOrder.success", {
      email,
      senderId,
      orderId
    });
    return true;
  } catch (error) {
    console.error("putInstagramOrder.error", {
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
    const { finalQuestion, dateExtracted, dateApplied } = resolveOpenAIQuestion(modelSelected, message || "");

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
      defaultModel: DEFAULT_OPENAI_MODEL,
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
      messages: [ { "role": "system", "content": prompt }, ...historyForOpenAI],
      temperature: 0,
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
 * Envía un mensaje a un usuario de Instagram usando la Graph API.
 * Basado en el formato cURL que mencionaste.
 */
async function sendInstagramMessage(recipientId, text) {
  const url = "https://graph.instagram.com/v21.0/me/messages";
  const headers = {
    Authorization: `Bearer ${PAGE_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  };

  const payload = {
    recipient: JSON.stringify({ id: recipientId }),
    message: JSON.stringify({ text }),
  };

  const res = await global.fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`Error enviando mensaje a ${recipientId}: ${errText}`);
  }

  return res;
}



/**
 * Busca un registro en DynamoDB por PK y coincidencia parcial en email_senderId
 * @param {string} partialSender - Texto parcial a buscar en email_senderId
 * @returns {Promise<Object|null>} - Retorna el primer item encontrado o null
 */
export async function findInstagram(accountID) {
  if (!accountID) throw new Error("Falta parámetro accountID");

  const command = new GetItemCommand({
    TableName: TABLE_NAME_SETTING,
    Key: {
      PK: { S: "INSTAGRAM" },
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


export async function getInstagramUser(email, senderId) {
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

export async function putInstagramUser(email, senderId, name, status = true) {
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

export async function updateTimestampInstagramUser(email, senderId) {
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

export async function updateInstagramUserStatus(email, senderId, status) {
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

export async function obtenerPerfilInstagram(igsid, accessToken) {
  const url = new URL(`https://graph.instagram.com/v25.0/${igsid}`);
  url.searchParams.set("fields", "id,name,username,profile_pic");

  const response = await global.fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      data?.error?.message || "No se pudo obtener el perfil de Instagram"
    );
  }

  return data || {};
}

export async function updateInstagramUserProfileIfMissing(email, senderId, accessToken) {
  try {
    const existing = await getInstagramUser(email, senderId);
    if (!existing) {
      console.log("updateInstagramUserProfileIfMissing.skip_no_user", { email, senderId });
      return;
    }

    const hasName = Boolean(String(existing?.name || "").trim()) && !String(existing?.name || "").startsWith("Usuario#");
    const hasUsername = Boolean(String(existing?.username || "").trim());
    const hasProfilePic = Boolean(String(existing?.profile_pic || "").trim());

    if (hasName && hasUsername && hasProfilePic) {
      console.log("updateInstagramUserProfileIfMissing.skip_complete", { email, senderId });
      return;
    }

    const profile = await obtenerPerfilInstagram(senderId, accessToken);
    console.log("updateInstagramUserProfileIfMissing.profile", profile);

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
      console.log("updateInstagramUserProfileIfMissing.skip_no_updates", { email, senderId });
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

    console.log("updateInstagramUserProfileIfMissing.success", {
      email,
      senderId,
      updatedFields: Object.keys(expressionAttributeNames).map((key) => expressionAttributeNames[key])
    });
  } catch (err) {
    console.error("❌ Error al actualizar perfil de Instagram:", err);
  }
}

export async function upsertInstagramUser(email, senderId, name, status = true) {
  try {
    // 🔹 1️⃣ Buscar si el registro ya existe
    const existing = await getInstagramUser(email, senderId);

    if (!existing) {
      // 🔹 2️⃣ Crear el nuevo registro
      await putInstagramUser(email, senderId, name, status);
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
