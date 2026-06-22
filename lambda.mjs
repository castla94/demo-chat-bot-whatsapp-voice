// Importa las dependencias necesarias
import { DynamoDBClient, PutItemCommand, UpdateItemCommand,QueryCommand,GetItemCommand } from "@aws-sdk/client-dynamodb";
import { encrypt_object, encrypt_object_id, decrypt_object, decrypt_object_id } from '/opt/aes256.mjs';
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { unmarshall } from "@aws-sdk/util-dynamodb"; // Utilidad para convertir los datos
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

const sqs = new SQSClient({ region: "us-east-1" });
const queueUrl = "https://sqs.us-east-1.amazonaws.com/967208159246/sqs-actions-whatsapp"; // Reemplaza con tu URL de SQS

// Crea un cliente de DynamoDB
const dynamoDBClient = new DynamoDBClient({ region: 'us-east-1' });

const s3 = new S3Client({ region: 'us-east-1' });


// Función Lambda handler
export const handler = async (event) => {
  
 let tableName = "whatsapp_conversation";

 let emailEncrypt = event.queryStringParameters?.email;  // Conversión a string
 
 let email_bk = event.queryStringParameters?.email_bk;  // Conversión a string
 console.log("email_bk",decodeURIComponent(email_bk))
 let email = "";
 if(!emailEncrypt){
   email = email_bk;
 }else{
    email = decrypt_object_id(emailEncrypt);
 }

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
  
  if(email === "admin 1@dentsmile.cl"){
    email = "admin+1@dentsmile.cl"
  }
  
  const { phone,message_user,message_openia,imageBase64,type="",type_user="user" } =  JSON.parse(event.body);
  
  console.log("request:",[phone,message_user,message_openia,imageBase64,type])

  if (!phone) {
    return {
      headers: {
            "Access-Control-Allow-Origin": "*", // Or specify your domain
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Allow-Methods": "POST"
        },
      statusCode: 400,
      body: JSON.stringify({ message: 'phone,message_user,message_openia are required parameters' })
    };
  }
  
  const expire = generateExpirateDate(720);
  const timestamp = new Date().toISOString()
  
  const cleaned_timestamp = timestamp.replace(/[:.\s]/g, "");
  
  let resultS3;
  let keyImagen = "";
  
  
  if(imageBase64){
      const extension = (type === "file") ? ".pdf":".jpg"
      keyImagen = getNameUser(email)+"/"+phone+"_"+cleaned_timestamp+extension;
      console.log("imageBase64",imageBase64)
      
      if(type === "imagen"){
        resultS3 = await uploadBase64ImageToS3(
          imageBase64,
          keyImagen,
        );
      }
      if(type === "file"){
        resultS3 = await uploadBase64PdfToS3(
          imageBase64,
          keyImagen,
        );
      }
  }
  
  const keyResultS3 = (resultS3) ? keyImagen: "";

  const params = {
    TableName: tableName,
    Item: {
      email: { S: email },
      phone: { S: phone+"_"+timestamp },
      message_user: { S: message_user },
      message_openia: { S: message_openia },
      imageBase64: { S: imageBase64 === undefined ? "" : keyResultS3 },
      typeMedia: { S: type === undefined ? "" : type },
      expire: { N: expire },
      type_user:{ S: type_user === undefined ? "" : type_user },
      timestamp: { S: timestamp }
    }
  }
  console.log("params",params)

  try {
    // Ejecuta la operación PutItem en DynamoDB
    const command = new PutItemCommand(params);
    await dynamoDBClient.send(command);
    
    await updateUserData(email, phone, timestamp)
    
    
    try {
      
         const getPlan = await getPremiunUser(email)
        console.log("getPlan:",getPlan)
         if(getPlan && getPlan === "Enterprise" && message_user !== '' && message_openia !== '' ){
            const nameItem = await getUserByEmailAndNumber(email, phone)
            console.log("User status:",nameItem)
         if(nameItem && nameItem.status){
             const stepFunnel = await getFunnel(email)
             console.log("stepFunnel:",stepFunnel)
             if(stepFunnel !== null && stepFunnel !== nameItem.funnel_step ){
               const historyConversations = await getMessagesFromDynamoDB (email, phone)
               console.log("historyConversations:",historyConversations)
               if(historyConversations !== null && stepFunnel.length > 1){
                const responseIA = await createStepFunnel(stepFunnel,historyConversations)
                 await updateSession(email,phone,responseIA,message_user,nameItem)
                 const action = JSON.parse(stepFunnel).find(act => act.id === responseIA || act.name === responseIA)
                 console.log("action find:",action)
                 if(action){
                   const messages = {
                     email:email,
                     phone_session:phone,
                     name_session:nameItem.name,
                     action:action.action,
                     action_value:(action.action_value) ? action.action_value : "",
                     funnel_step:responseIA
                   }
                   await sendMessagesSQS (messages)
                 }
               }
             }
          }else{
              console.log("User status disable")
          }
         }
    } catch (error) {
    console.error('Error processing step funnel', error);
    }
     
    return {
      headers: {
            "Access-Control-Allow-Origin": "*", // Or specify your domain
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Allow-Methods": "POST"
        },
      statusCode: 200,
      body: JSON.stringify({ message: 'Item successfully added to DynamoDB' })
    };
  } catch (error) {
    console.error('Error putting item into DynamoDB', error);
    return {
      headers: {
            "Access-Control-Allow-Origin": "*", // Or specify your domain
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Allow-Methods": "POST"
        },
      statusCode: 500,
      body: JSON.stringify({ message: 'Error putting item into DynamoDB', error: error.message })
    };
  }
};


function getNameUser(email) {
    let part = email.split('@');
    if (part.length > 1) {
        // Reemplaza todos los puntos en la parte del nombre de usuario
        let username = part[0].replace(/\./g, '');
        return username;
    } else {
        throw new Error('El formato del correo no es válido.');
    }
}


export async function uploadBase64ImageToS3(imageBase64, key) {
  try {
     const base64Clean = imageBase64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, "");
    const bufferImg = Buffer.from(base64Clean, "base64");

    const bucketName = "bot-imagenes-contact"

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: bufferImg,
      ContentType: "image/jpeg", // Forzamos a tratarlo como JPG
      ContentEncoding: "base64",
    });

    const response = await s3.send(command);
    console.log(`✅ Imagen subida correctamente a s3://${bucketName}/${key}`);
    return true;
  } catch (error) {
    console.error("❌ Error subiendo imagen:", error.message);
    return false
  }
}


export async function uploadBase64PdfToS3(pdfBase64, key) {
  try {
    const base64Clean = pdfBase64.replace(/^data:application\/pdf;base64,/, "");
    const bufferPdf = Buffer.from(base64Clean, "base64");

    const bucketName = "bot-imagenes-contact"

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: bufferPdf,
      ContentType: "application/pdf",
      ContentEncoding: "base64",
    });

    const response = await s3.send(command);
    console.log(`✅ PDF uploaded successfully to s3://${bucketName}/${key}`);
    return true;
  } catch (error) {
    console.error("❌ Error uploading PDF:", error.message);
    return false
  }
}


export const generateExpirateDate =  (expirateDate) => {
  const ttlInHours = expirateDate;
  const ttlInSecounds = ttlInHours * 60 * 60;
  const expirateTime = Math.floor(Date.now()/1000) + ttlInSecounds;
  return  expirateTime.toString();
}

async function updateUserData(email, number, timestamp) {
  const params = {
    TableName: "whatsapp_sessions",
    Key: {
      email: { S: email },
      number: { S: number }
    },
    UpdateExpression: "SET #ts = :timestamp",
    ExpressionAttributeNames: {
      "#ts": "timestamp"
    },
    ExpressionAttributeValues: {
      ":timestamp": { S: timestamp }
    },
    // Add condition to check if item exists
    ConditionExpression: "attribute_exists(email)"
  };
  
  console.log("param updateUserData ",params)

  try {
    // Execute UpdateItem operation in DynamoDB
    const command = new UpdateItemCommand(params);
    const result = await dynamoDBClient.send(command);
    
    // Log successful update
    console.log(`Successfully updated data for user: ${email}`);
    return result;
  } catch (error) {
    console.error('Error updating user data:', error);
  }
}



async function createStepFunnel(stepFunnel,historyMessageContact) {
  
  const normalizeFunnelSteps = (raw) => {
    let parsed = raw;
    if (typeof raw === "string") {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = [];
      }
    }

    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((step) => {
        const name = (step?.name ?? step?.id ?? "").toString().trim();
        const description = (step?.description ?? "").toString().trim();
        return name ? { name, description } : null;
      })
      .filter(Boolean);
  };

  const normalizeHistory = (raw) => {
    let parsed = raw;
    if (typeof raw === "string") {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = [];
      }
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.map((m) => ({
      type: (m?.type ?? "").toString(),
      message: (m?.message ?? "").toString(),
      timestamp: (m?.timestamp ?? "").toString()
    }));
  };

  const funnelSteps = normalizeFunnelSteps(stepFunnel);
  const history = normalizeHistory(historyMessageContact);
  const allowedStepNames = funnelSteps.map((s) => s.name);

  const prompt = `Actúa como un experto analista de ventas.

Tu tarea: determinar la etapa actual del funnel basándote principalmente en los mensajes del usuario (type: 'client'). Los mensajes type: 'bot' son solo contexto.

Instrucciones de análisis:
- El historial de conversación del usuario: type: 'client' contiene los mensajes enviados por el usuario y type: 'bot' representa las respuestas del bot.
- Realiza un análisis profundo del historial de mensajes del contacto.
- Evalúa el contexto completo de la conversación para determinar:
  * Etapa actual en el ciclo de ventas
  * Nivel de compromiso e interés demostrado
  * Objeciones o preocupaciones expresadas
  * Necesidades específicas mencionadas
  * Intención de compra
  * Tiempo transcurrido desde la última interacción
- También analiza dentro del funnel de ventas la propiedad "description" y evalúa (según el prompt escrito en el historial de la conversación) cuál etapa corresponde.

Datos del funnel (usa SOLO la propiedad "description" para decidir, no uses id, action, action_value, name para inferir la etapa):
${JSON.stringify(funnelSteps, null, 2)}

Historial de conversación (prioriza type: 'client'):
${JSON.stringify(history, null, 2)}

Criterios de clasificación:
- Asigna el contacto a la etapa del funnel más apropiada basándote en el historial completo de conversaciones y en:
${JSON.stringify(stepFunnel)}

Reglas estrictas:
- Debes escoger UNA etapa cuyo "description" sea la mejor coincidencia con la intención/estado del usuario.
- Responde SOLO con el texto exacto del campo "name" de una de estas etapas:
${JSON.stringify(allowedStepNames)}
- Si no hay suficiente información, responde "${allowedStepNames[0] ?? "Inicio"}".`;
    
    
console.log("build request createStepFunnel:",prompt)

  const url = 'https://api.openai.com/v1/responses';
  // Set timeout of 30 seconds
  let response

  try {
      response = await global.fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: [
          {
            role: "system", 
            content: [
              {
                type: "input_text",
                text: prompt
              }
            ]
          }
        ],
        text: {
          format: {
            type: "text"
          }
        }
      })
    });

    const data = await response.json();
    
    const resultDataRaw = data?.output?.[0]?.content?.[0]?.text ?? "";
    const resultData = resultDataRaw.toString().trim();

    console.log("response createStepFunnel:",resultData)
  
    if (!response.ok) {
      console.log('Error en la solicitud a OpenAI',data.error.message)
    }
  
    if (allowedStepNames.includes(resultData)) return resultData;

    const normalized = resultData.toLowerCase();
    const match = allowedStepNames.find((name) => name.toLowerCase() === normalized);
    if (match) return match;

    return allowedStepNames[0] ?? "Inicio";
  } catch (error) {
      console.log('Request timed out after 30 seconds');
      return null;
  }
}



async function getMessagesFromDynamoDB (email, number) {
  const params = {
    TableName: 'whatsapp_conversation',
    KeyConditionExpression: "#email = :email AND begins_with(#phone, :phonePrefix)",
    ExpressionAttributeNames: {
      "#email": "email",
      "#phone": "phone"
    },
    ExpressionAttributeValues: {
      ":email": { S: email },
      ":phonePrefix": { S: number }
    }
  };

  try {
    // Execute QueryCommand operation on DynamoDB
    const command = new QueryCommand(params);
    const data = await dynamoDBClient.send(command);
    
    // Process messages from DynamoDB items
    const processMessages = (item) => {
      let newMessages = [];
      if (item.message_user?.S) {
        newMessages.push({
          id: Date.now(), // Using timestamp as unique ID
          type: 'client',
          message: item.message_user.S,
          timestamp: item.timestamp.S
        });
      }
      if (item.message_openia?.S) {
        newMessages.push({
          id: Date.now() + 1, // Ensuring unique ID for bot message
          type: 'bot',
          message: item.message_openia.S,
          timestamp: item.timestamp.S
        });
      }
      return newMessages;
    };

    // Process all items in the response
    let messages = [];
    if (data.Items && data.Items.length > 0) {
      data.Items.forEach(item => {
        messages = [...messages, ...processMessages(item)];
      });
    }

    return messages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  } catch (error) {
    console.error('Error fetching messages from DynamoDB:', error);
  }
};


async function getFunnel(email){
    const tableName = 'whatsapp_funnel';
    // Create parameters for getting item from DynamoDB
    const getItemParams = {
        TableName: tableName,
        Key: {
            "email": { S: email }
        }
    };

    try {
        // Get the item from DynamoDB
        const getItemResult = await dynamoDBClient.send(new GetItemCommand(getItemParams));
        const result = unmarshall(getItemResult.Item);
        return (result) ? result.funnelSteps:null
    } catch (error) {
        console.error("Error getFunnel:",error)
        await setFunnel(email)
        return null
    }
}


async function getPremiunUser(email){
    const tableName = 'whatsapp_premiun';
    // Create parameters for getting item from DynamoDB
    const getItemParams = {
        TableName: tableName,
        Key: {
            "email": { S: email }
        }
    };

    try {
        // Get the item from DynamoDB
        const getItemResult = await dynamoDBClient.send(new GetItemCommand(getItemParams));
        const result = unmarshall(getItemResult.Item);
        return (result) ? result.plan:null
    } catch (error) {
        console.error("Error getPremiunUser:",error)
        return null
    }
}


async function setFunnel(email){
    const tableName = 'whatsapp_funnel';
    const putParams = {
        TableName: tableName,
        Item: {
            email: { S: email },
            funnelSteps: { S: JSON.stringify([{"id":"Inicio","name":"Inicio","description":"Inicio","action":"NONE","action_value":""}]) },
            funnelTasks: { S: "" },
            timestamp: { S: new Date().toISOString() }
        }
    };
    try {
        // Get the item from DynamoDB
        await dynamoDBClient.send(new PutItemCommand(putParams));
    } catch (error) {
        console.error("Error setFunnel:",error)
    }
}


async function getUserByEmailAndNumber(email, number) {
  const params = {
    TableName: "whatsapp_sessions",
    Key: {
      email: { S: email },
      number: { S: number }
    }
  };

  try {
    const command = new GetItemCommand(params);
    const data = await dynamoDBClient.send(command);
    
    if (!data.Item) {
      return null;
    }

  console.log("getUserByEmailAndNumber data.Item: ",data.Item)

    const name = data.Item.name ? data.Item.name.S : null;
    const reminder = data.Item.reminder ? data.Item.reminder.S : null;
    const funnel_step = data.Item.funnel_step ? data.Item.funnel_step.S : null;
    const status = data.Item.status ? data.Item.status.BOOL : null;
    const timestamp = data.Item.timestamp ? data.Item.timestamp.S : null;

    return {name,reminder,funnel_step,status,timestamp};
  } catch (error) {
    console.error('Error getUserByEmailAndNumber', error);
    return null
  }
}

async function updateSession(email,phone,funnel_step,last_message,nameItem){
    
  if(nameItem !== null && funnel_step !== nameItem.funnel_step){
    
      const params = {
        TableName: "whatsapp_sessions",
        Item: {
          email: { S: email },
          number: { S: phone },
          name: { S: nameItem.name },
          status: { BOOL: nameItem.status  },
          reminder: { S: nameItem.reminder },
          timestamp: { S: nameItem.timestamp },
          funnel_step: { S: funnel_step },
          last_message: { S: last_message }
        }
      };
    
      try {
        console.log("param updateSession:",params)
        // Ejecuta la operación PutItem en DynamoDB
        const command = new PutItemCommand(params);
        await dynamoDBClient.send(command);
        
        console.log('Item successfully added to DynamoDB' )
      } catch (error) {
        console.error('Error updateSession', error);
      }
  }

}


async function sendMessagesSQS (messages) {
    const params = {
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(messages)
    };

    // Add delay for image and PDF messages
    if (messages.action === "SENT_IMAGE" || messages.action === "SENT_PDF") {
      params.DelaySeconds = 20;
    }

    try {
      const response = await sqs.send(new SendMessageCommand(params));
      console.log(`Mensaje (${messages.email}) ${messages.funnel_step}`, response.MessageId);
    } catch (err) {
      console.error("Error enviando mensaje a SQS ", err);
    }
};
