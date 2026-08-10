import { encrypt_object, encrypt_object_id, decrypt_object, decrypt_object_id } from '/opt/aes256.mjs';

// Función Lambda handler
export const handler = async (event) => {

       
 let emailEncrypt = event.queryStringParameters?.email;  // Conversión a string
 
 let email = decrypt_object_id(emailEncrypt);

  if (!email) {
    return {
       headers: {
            "Access-Control-Allow-Origin": "*", // Or specify your domain
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Allow-Methods": "POST"
        },
      statusCode: 400,
      body: JSON.stringify({ message: 'email is a required query parameter' })
    };
  }
  
  
    const { prompt,history } =  JSON.parse(event.body);

  try {
    
    
    const lastUserMessage = history.filter(m => m.role === "user").at(-1)?.content || "";
    const classification = await classifyIntent(lastUserMessage);

    const modelSelected = classification.requires_strong_model ? "gpt-4o" : "gpt-4.1-mini";
    console.log("modelSelected:",modelSelected)

    const { finalQuestion, dateExtracted, dateApplied } = resolveOpenAIQuestion(modelSelected, lastUserMessage);

    const historyForOpenAI = [...history];
    const lastUserIndex = [...historyForOpenAI].map((item, idx) => ({ item, idx })).reverse().find((entry) => entry?.item?.role === 'user')?.idx ?? -1;

    if (lastUserIndex >= 0) {
        historyForOpenAI[lastUserIndex] = {
            ...(historyForOpenAI[lastUserIndex] || {}),
            role: 'user',
            content: finalQuestion
        };
    }

    console.log("resolveOpenAIQuestion applied", {
        lastUserMessage,
        finalQuestion,
        dateExtracted,
        dateApplied,
        lastUserIndex
    });

    
  const url = 'https://api.openai.com/v1/chat/completions';
  const response = await global.fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
        model: modelSelected,
        messages: [
            {
                "role": "system",
                "content": prompt
            },
            ...historyForOpenAI
        ],
        temperature: 0,
        top_p: 1, 
        frequency_penalty: 0,
        presence_penalty: 0,
    })
  });

  const data = await response.json();

  console.log("data.usage",data.usage)

  if (!response.ok) {
    throw new Error(data.error.message || 'Error en la solicitud a OpenAI');
  }
  

    return {
       headers: {
            "Access-Control-Allow-Origin": "*", // Or specify your domain
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Allow-Methods": "POST"
        },
      statusCode: 200,
      body: JSON.stringify({item:data})
    };
    
  } catch (error) {
    console.error('Error getting item from DynamoDB', error);
    return {
       headers: {
            "Access-Control-Allow-Origin": "*", // Or specify your domain
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Allow-Methods": "POST"
        },
      statusCode: 500,
      body: JSON.stringify({ message: 'Error getting reponse OPENIA', error: error.message })
    };
  }
};


function resolveOpenAIQuestion (modelSelected, question) {
  if (modelSelected !== 'gpt-4o') {
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

function extractDate(message) {
  const regex = /\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})\b/;

  const match = String(message || '').match(regex);

  if (!match) {
      return null;
  }

  let [, day, month, year] = match;

  day = day.padStart(2, '0');
  month = month.padStart(2, '0');

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
    /\b(hoy|manana|mañana|ayer|pasado manana|pasado mañana|proximo|próximo|semana proxima|semana próxima|fin de semana|mes que viene|mes proximo|mes próximo)\b/,
    /\b(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b/,
    /\b(lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo)\b/
  ];

  return patterns.some((pattern) => pattern.test(text));
}
