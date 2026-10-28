import { DynamoDBClient, GetItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
 
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const client = new LambdaClient({ region: "us-east-1" });

// Crea un cliente de DynamoDB
const dynamoDBClient = new DynamoDBClient({ region: 'us-east-1' });

// Define el nombre de la tabla de DynamoDB
const tableName = "whatsapp_prompt";

// Función Lambda handler
export const handler = async (event) => {

    
  const { email,question,phone } =  JSON.parse(event.body);

  
  console.log("prompt query : ",[email,question])

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

  const params = {
    TableName: tableName,
    Key: {
      email: { S: email }
    }
  };

  try {
    // Ejecuta la operación GetItem en DynamoDB
    const command = new GetItemCommand(params);
    const data = await dynamoDBClient.send(command);
    
    if (!data.Item) {
      return {
         headers: {
            "Access-Control-Allow-Origin": "*", // Or specify your domain
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Allow-Methods": "POST"
        },
        statusCode: 404,
        body: JSON.stringify({ message: 'Item not found'})
      };
    }

    // Mapear los fields de data.Item a un objeto plano
    const items = Object.fromEntries(
      Object.entries(data.Item).map(([key, value]) => [key, Object.values(value)[0]])
    );

    const prompt_draft = items.prompt;
    const url_menu = items.s3_url_menu;

    let prompt = prompt_draft.replaceAll('{whatsapp_name}', items.name)
    .replaceAll('{whatsapp_description}', items.description)
    .replaceAll('{whatsapp_products}', items.products)
    .replaceAll('{whatsapp_format_order}', items.format_order)
    .replaceAll('{whatsapp_account_banking}', items.account_banking)
    .replaceAll('{whatsapp_instruccions_iteration}', items.instruccions_iteration)
    .replaceAll('{whatsapp_how_responding_customer}', items.how_responding_customer)
    .replaceAll('{whatsapp_tono}', items.tono)
    .replaceAll('{whatsapp_welcome}', items.welcome)
    .replaceAll('{whatsapp_goal}', items.goal);
    
    prompt = prompt + obtenerFechaChile()
    
    const getIntegration = await searchInDynamoDB(email)
    
    console.log("getIntegration",getIntegration)
    
    if(getIntegration !== null && getIntegration.status){
      const resultIntegration =  await processStringWithIntegrations(prompt,getIntegration,question)
      console.log("resultIntegration",resultIntegration)
      if(resultIntegration !== null){
        prompt = resultIntegration
      }
    }

    // Añadir la nota al final, una vez resueltas todas las integraciones.
    prompt = await obtenerNotaInterna(email, phone) + prompt

    console.log("prompt:",prompt)

    return {
       headers: {
            "Access-Control-Allow-Origin": "*", // Or specify your domain
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Allow-Methods": "POST"
        },
      statusCode: 200,
      body: JSON.stringify({prompt:prompt,url_menu:url_menu,welcome:items.welcome,products:items.products,products_dynamic:items?.products_dynamic})
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
      body: JSON.stringify({ message: 'Error getting item from DynamoDB', error: error.message })
    };
  }
};


async function lambdaGoogleDoc(url) {
  try {
    const params = {
      FunctionName: "arn:aws:lambda:us-east-1:967208159246:function:integration-whatsapp-google-doc", // nombre o ARN de Lambda B
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify({ url: url })),
    }; 

    const command = new InvokeCommand(params);
    const response = await client.send(command);

    // response.Payload es un Uint8Array -> hay que transformarlo
    const payloadString = Buffer.from(response.Payload).toString("utf8");
    const result = JSON.parse(payloadString);

    console.log("Respuesta desde lambdaGoogleDoc:", result.body.text);

    return result.body.text; // Devuelve la respuesta de Lambda B como objeto JSON pars
  } catch (error) {
    console.error("Error al invocar lambdaGoogleDoc", error);
    return null
  }
}


async function lambdaGoogleCalendar(url) {
  try {
    const params = {
      FunctionName: "arn:aws:lambda:us-east-1:967208159246:function:integration-whatsapp-google-calendar", // nombre o ARN de Lambda B
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify({ url: url })),
    }; 

    const command = new InvokeCommand(params);
    const response = await client.send(command);

    // response.Payload es un Uint8Array -> hay que transformarlo
    const payloadString = Buffer.from(response.Payload).toString("utf8");
    const result = JSON.parse(payloadString);

    console.log("Respuesta desde lambdaGoogleCalendar:", result);

    return result.body.text; // Devuelve la respuesta de Lambda B como objeto JSON pars
  } catch (error) {
    console.error("Error al invocar lambdaGoogleCalendar", error);
    return null
  }
}


async function lambdaGoogleSheet(url) {
  try {
    const params = {
      FunctionName: "arn:aws:lambda:us-east-1:967208159246:function:integration-whatsapp-google-sheet", // nombre o ARN de Lambda B
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify({ url: url })),
    }; 

    const command = new InvokeCommand(params);
    const response = await client.send(command);

    // response.Payload es un Uint8Array -> hay que transformarlo
    const payloadString = Buffer.from(response.Payload).toString("utf8");
    const result = JSON.parse(payloadString);

    console.log("Respuesta desde lambdaGoogleSheet:", result.body.text);

    return result.body.text; // Devuelve la respuesta de Lambda B como objeto JSON pars
  } catch (error) {
    console.error("Error al invocar lambdaGoogleSheet", error);
    return null
  }
}

async function lambdaJson(url) {
  try {
    const params = {
      FunctionName: "arn:aws:lambda:us-east-1:967208159246:function:integration-whatsapp-json", // nombre o ARN de Lambda B
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify({ url: url })),
    }; 

    const command = new InvokeCommand(params);
    const response = await client.send(command);

    // response.Payload es un Uint8Array -> hay que transformarlo
    const payloadString = Buffer.from(response.Payload).toString("utf8");
    const result = JSON.parse(payloadString);

    console.log("Respuesta desde lambdaJson:", result);

    return result.body.text; // Devuelve la respuesta de Lambda B como objeto JSON pars
  } catch (error) {
    console.error("Error al invocar lambdaJson", error);
    return null
  }
}

async function lambdaAgenteWeb(url,when_to_activate,message,action_instruction,information_to_obtain) {
  try {
    const params = {
      FunctionName: "arn:aws:lambda:us-east-1:967208159246:function:integration-whatsapp-agente-web", // nombre o ARN de Lambda B
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify({ url: url, when_to_activate:when_to_activate,message:message,action_instruction:action_instruction,information_to_obtain:information_to_obtain })),
    }; 

    const command = new InvokeCommand(params);
    const response = await client.send(command);

    // response.Payload es un Uint8Array -> hay que transformarlo
    const payloadString = Buffer.from(response.Payload).toString("utf8");
    const result = JSON.parse(payloadString);

    console.log("Respuesta desde lambdaAgenteWeb:", result);

    return result.body.text; // Devuelve la respuesta de Lambda B como objeto JSON pars
  } catch (error) {
    console.error("Error al invocar lambdaAgenteWeb", error);
    return null
  }
}


// 🔹 Aquí defines qué hacer por cada tipo
async function callLambdaByType(integration,question) {
  try {
    switch (integration.type) {
      case 'json':
        console.log(`📦 Llamando Lambda para JSON en sección ${integration.section} -> ${integration.url}`);
        return await lambdaJson(integration.url);
      case 'google_sheets':
        console.log(`📊 Llamando Lambda para Google Sheets en sección ${integration.section} -> ${integration.url}`);
        return await lambdaGoogleSheet(integration.url);
      case 'google_calendar':
        console.log(`📅 Llamando Lambda para Google Calendar en sección ${integration.section} -> ${integration.url}`);
        return await lambdaGoogleCalendar(integration.url);
      case 'google_doc':
        console.log(` Llamando Lambda para Google Doc en sección ${integration.section} -> ${integration.url}`);
        return await lambdaGoogleDoc(integration.url);
      case 'web_agent':
        console.log(` Llamando Lambda para Agente Web en sección ${integration.section} -> ${integration.url}`);
        return await lambdaAgenteWeb(integration.url,integration.when_to_activate,question,integration.action_instruction,integration.information_to_obtain) ;

      default:
        console.warn(`⚠️ Tipo no soportado: ${integration.type}`);
        return null;
    }
  } catch (error) {
    console.error('Error in callLambdaByType:', error);
    return null;
  }
}


async function searchInPrompt(
  prompt,
  question
) {
  const apiKey = process.env.OPENAI_API_KEY;
  const url = "https://api.openai.com/v1/responses";
  console.log("searchInPrompt.start", {
    hasApiKey: !!apiKey,
    hasPrompt: !!prompt,
    hasQuestion: !!question
  });

  if (!prompt || !question) {
    return "NO HAY INFORMACION";
  }

  const systemText = `
Eres un asistente que busca informacion dentro de una fuente de texto tabular.

Recibiras:
1) Un texto fuente llamado prompt.
2) Una pregunta del usuario.

Tu tarea:
- Buscar dentro del prompt filas o bloques de informacion relacionados con la pregunta del usuario.
- La busqueda no debe ser solamente exacta; tambien debe considerar coincidencias parciales, semanticas, categorias, meses, rangos, productos, nombres parecidos y contexto relacionado.
- Si la pregunta es amplia o parcial, devuelve todas las filas relevantes que ayuden a responder.
- Ejemplo: si la pregunta es "junio", debes devolver todas las filas que contengan fechas, eventos, productos o informacion relacionada con junio, aunque la fecha no venga exactamente igual a la pregunta.
- Debes interpretar fechas en lenguaje natural y relacionarlas con fechas escritas en otros formatos.
- Si el usuario pregunta por disponibilidad, fechas, reservas, agenda o calendario, debes buscar usando equivalencias de fecha aunque no coincidan literalmente.
- Debes entender referencias como: "hoy", "manana", "pasado manana", "este viernes", "proximo viernes", "viernes 26", "26 de junio", "junio", "fin de semana", "semana proxima".
- Debes relacionar fechas aunque en el prompt aparezcan en otro formato, por ejemplo:
  "viernes 26" puede corresponder a "26/06/2026", "2026-06-26", "26-06-2026", "26 de junio", "viernes 26 de junio".
- Si el usuario entrega un mes, devuelve todas las filas de ese mes.
- Si el usuario entrega un dia de la semana con numero, devuelve todas las filas compatibles con esa combinacion o muy cercanas semanticamente.
- Si el usuario pregunta por un producto, servicio, categoria, ciudad, nombre o caracteristica, devuelve todas las filas relacionadas aunque usen sinonimos o texto parecido.
- Si la pregunta apunta a una categoria o concepto general, devuelve todas las filas que pertenezcan a esa categoria o que sean claramente relevantes.
- Si encuentras coincidencias, devuelve SOLO las filas encontradas en el mismo formato original del prompt.
- Si no encuentras coincidencia suficiente, devuelve exactamente: NO HAY INFORMACION

Reglas:
- No inventes datos.
- No resumes ni reformatees.
- No expliques el resultado.
- No agregues markdown.
- Si hay multiples filas relevantes, devuelvelas todas separadas por salto de linea.
- Prioriza recall util sobre una coincidencia demasiado estricta.
- Si la consulta del usuario es ambigua pero apunta claramente a un conjunto de resultados, devuelve todas las filas potencialmente utiles.
- Solo responde NO HAY INFORMACION cuando realmente no exista ninguna fila razonablemente relacionada.
- Devuelve unicamente las filas encontradas o NO HAY INFORMACION.
`.trim();

  const userText = `
Pregunta del usuario: ${JSON.stringify(question)}

Texto fuente:
${String(prompt)}
`.trim();

  const payload = {
    model: "gpt-4o-mini",
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: systemText }]
      },
      {
        role: "user",
        content: [{ type: "input_text", text: userText }]
      }
    ],
    text: {
      format: { type: "text" }
    },
    temperature: 0.2,
    max_output_tokens: 1200,
    top_p: 1
  };

  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`
  };

  try {
    const response = await global.fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });
    console.log("searchInPrompt.response", { ok: response.ok, status: response.status });

    if (!response.ok) {
      console.log("searchInPrompt.http_error");
      return "NO HAY INFORMACION";
    }

    const data = await response.json();
    const raw = data.output?.[0]?.content?.[0]?.text;
    console.log("searchInPrompt.raw", { raw });

    if (!raw) return "NO HAY INFORMACION";

    const result = String(raw).trim();
    if (!result) {
      return "NO HAY INFORMACION";
    }

    return result;
  } catch (err) {
    console.log("searchInPrompt.error", {
      message: err?.message || ""
    });
    return "NO HAY INFORMACION";
  }
}


 
// 🔹 Función principal que analiza el string
async function processStringWithIntegrations(inputString, config,question) {
  try {
    let resultString = inputString;

    for (const integration of config.integrations) {
      const fieldSection = integration.section.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
      const token = `{#FUENTE_DATO_${fieldSection}}`;
        if(integration.status){
            console.log("resultString.includes("+token+")",resultString)
            if (resultString.includes(token)) {
              console.log("process Integrations MATCH ("+token+")")
              let lambdaResult = await callLambdaByType(integration,question);
              //lambdaResult = await searchInPrompt(lambdaResult,question);
              resultString = resultString.replace(token, lambdaResult || '');
            }
        }else{
          console.log("Integration ("+token+") Disabled")
        }
    }

    return resultString;
  } catch (error) {
    console.error('Error in processStringWithIntegrations:', error);
    return null;
  }
}

export const searchInDynamoDB = async (email) => {
  const tableName = "whatsapp_integrations";

  const params = {
    TableName: tableName,
    Key: {
      email: { S: email }
    }
  };

  try {
    const command = new GetItemCommand(params);
    const data = await dynamoDBClient.send(command);
    
    if (!data.Item) {
      return null;
    }
    
    return unmarshall(data.Item);
    
  } catch (error) {
    console.error('Error not found whatsapp_integrations:', error);
    return null
  }
};

async function obtenerNotaInterna(email, phone) {
  if (!phone) {
    return '';
  }

  const command = new QueryCommand({
    TableName: 'whatsapp_notes_sessions',
    KeyConditionExpression: '#email = :email AND #number_and_type = :number_and_type',
    ExpressionAttributeNames: {
      '#email': 'email',
      '#number_and_type': 'number_and_type',
      '#text': 'text'
    },
    ExpressionAttributeValues: {
      ':email': { S: email },
      ':number_and_type': { S: `${phone}#internal` }
    },
    ProjectionExpression: '#text'
  });

  const data = await dynamoDBClient.send(command);
  const text = data.Items?.[0] ? unmarshall(data.Items[0]).text : null;

  if (typeof text !== 'string' || !text.trim()) {
    return '';
  }

  return `\n\nNOTA INTERNA DEL CLIENTE:\n${text}\n\nREGLA DE PRIORIDAD: Siempre debes seguir las indicaciones de la NOTA INTERNA DEL CLIENTE. Si contradicen otras instrucciones de este prompt, las indicaciones de la nota interna tienen prioridad.\n`;
}

function obtenerFechaChile() {
  const now = new Date();

  const options = {
    timeZone: 'America/Santiago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  };

  const formatter = new Intl.DateTimeFormat('es-CL', options);
  const parts = formatter.formatToParts(now);

  const getPart = (type) => parts.find(p => p.type === type)?.value;

  const diaSemana = getPart('weekday');
  const dia = getPart('day');
  const mes = getPart('month');
  const anio = getPart('year');
  const anionext = parseInt(getPart('year'))+1;
  const hora = `${getPart('hour')}:${getPart('minute')}`;

  const fecha = `${dia}/${mes}/${anio}`;
return `\n11. Aprende la fecha y hora actual es :Hoy es ${diaSemana}, ${fecha}.
📌 INTERPRETACIÓN DE FECHAS:
1. Siempre que un usuario entregue una fecha **sin año**, debes **asignar automáticamente el año usando la fecha actual como referencia**, aplicando EXCLUSIVAMENTE estas reglas:
   - **Solo considera el año siguiente (${anionext}) cuando el mes actual es diciembre**.
   - Si el mes actual es **diciembre** y el usuario indica un **mes que ya pasó** (por ejemplo enero, febrero, etc.), debes **asumir automáticamente que la fecha corresponde al año siguiente (${anionext})**.
   - En cualquier otro mes del año, si el usuario no indica año, **asume siempre el año actual (${anio})**, incluso si el mes indicado ya pasó.
   - No evalúes si la fecha es pasada o futura: **solo interpreta el año según estas reglas**.

   👉 Ejemplo clave:
   - Fecha actual: diciembre ${anio}
   - Usuario dice: "martes 6 de enero"
   → Enero es un mes anterior a diciembre → **año = ${anionext}**.

2. Nunca digas que una fecha es inválida solo porque el usuario no incluyó el año.
3. Nunca corrijas, cuestiones ni preguntes "¿te refieres a...?" cuando la fecha sea interpretable según las reglas anteriores.
4. Solo pide confirmación si la fecha es ambigua en el **formato día/mes** (ejemplo: 03/04 → ¿3 de abril o 4 de marzo?).
5. Devuelve siempre la fecha en dos formas:
   - Forma legible para humanos (ejemplo: martes 6 de enero de ${anionext} o ${anio} según corresponda).
   - Formato ISO (YYYY-MM-DD).
6. Zona horaria por defecto: America/Santiago.
7. Nunca respondas con frases como “esa fecha no es válida” o “esa fecha es incorrecta”.  
   Si la fecha no existe en el calendario correspondiente, responde únicamente:
   "Esa fecha no existe en el calendario de ${anio} o ${anionext}. ¿Quieres elegir otra?".
📌 INTERPRETACIÓN DE FECHAS RELATIVAS:
8. El asistente debe interpretar expresiones relativas usando la fecha actual como referencia:
   - "hoy" → fecha actual (${fecha})
   - "mañana" → fecha actual + 1 día
   - "pasado mañana" → fecha actual + 2 días
   - "ayer" → fecha actual - 1 día (solo si aplica al contexto)
   - "en X días" → sumar X días a la fecha actual
   - "la próxima semana" → rango desde el lunes siguiente
   - "este [día de la semana]" → el siguiente día correspondiente dentro de la semana actual o próxima
   - Estas fechas deben convertirse siempre a formato legible y formato ISO (YYYY-MM-DD)

📌 INTERPRETACIÓN DE DÍAS DE LA SEMANA:
9. Si el usuario menciona un día de la semana (ej: "lunes", "viernes") sin fecha:
   - Debes interpretarlo como el siguiente día correspondiente a partir de la fecha actual.
   - Si hoy es ese mismo día, asumir el siguiente de la próxima semana.

📌 INTERPRETACIÓN DE HORAS:
10. El asistente debe reconocer y entender distintos formatos de hora como:
   - "5pm", "17:00", "5 de la tarde", "17 hrs"
   - Rangos como "2pm - 4pm"
   Reglas:
   - Convertir siempre a formato 24 horas (HH:mm)
   - Asociar la hora a la fecha detectada
   - Si el usuario solo entrega una hora, asumir la fecha actual
   - Si hay ambigüedad (ejemplo: "a las 5"), solicitar confirmación (AM o PM)

📌 COMBINACIÓN FECHA + HORA:
11. Si el usuario entrega:
   - Solo fecha → usar fecha interpretada
   - Solo hora → usar fecha actual
   - Fecha + hora → combinar ambas correctamente

   👉 Ejemplo:
   - "mañana a las 5pm" → convertir a YYYY-MM-DD 17:00

📌 AMBIGÜEDAD SEMÁNTICA:
12. Si el usuario utiliza expresiones ambiguas como:
   - "en la tarde"
   - "temprano"
   - "más rato"
   - "el otro viernes"
   Debes solicitar confirmación antes de guardar el dato.


*IMPORTANTE: NUNCA INVENTES INFORMACIÓN QUE NO TENGAS EN TU BASE DE CONOCIMIENTO*`;

}
