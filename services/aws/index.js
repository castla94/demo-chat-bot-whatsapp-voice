const axios = require('axios');
const { defaultLogger } = require('../../helpers/cloudWatchLogger');
require('dotenv').config();

// Constantes para configuración
const BASE_URL = 'https://c0jkurvt19.execute-api.us-east-1.amazonaws.com/DEV';

/**
 * Registra créditos para el sistema WhatsApp
 * @param {number} credit - Cantidad de créditos a registrar
 * @returns {Promise<Object|null>} Respuesta de la API o null si hay error
 */
const postWhatsappCredit = async (credit) => {
  const email_bk = process.env.EMAIL_TOKEN;
  const endpoint = `${BASE_URL}/whatsapp-setting/credits`;

  try {
    const response = await axios.post(`${endpoint}?email_bk=${email_bk}`, { credit });
    return response.data;
  } catch (error) {
    defaultLogger.error('Error registrando créditos', {
      credit,
      error: error.message,
      stack: error.stack,
      action: 'post_whatsapp_credit_error',
      file: 'aws/index.js'
    });
    return null;
  }
};

/**
 * Registra una conversación de WhatsApp
 * @param {string} phone - Número de teléfono
 * @param {string} message_user - Mensaje del usuario
 * @param {string} message_openia - Respuesta del sistema
 * @returns {Promise<Object|null>} Respuesta de la API o null si hay error
 */
const postWhatsappConversation = async (phone, message_user, message_openia,imageBase64 = "",type = "imagen") => {
  const email_bk = process.env.EMAIL_TOKEN;
  const endpoint = `${BASE_URL}/whatsapp-conversation`;

  try {
    const response = await axios.post(`${endpoint}?email_bk=${email_bk}`, {
      phone,
      message_user,
      message_openia,
      imageBase64,
      type
    });
    return response.data;
  } catch (error) {
    defaultLogger.error('Error registrando conversación', {
      phone,
      error: error.message,
      stack: error.stack,
      action: 'post_whatsapp_conversation_error',
      file: 'aws/index.js'
    });
    return null;
  }
};


/**
 * Obtiene listado de conversaciones
 * @returns {Promise<number|null>} Objeto array con listado de conversaciones
 */
const getWhatsappConversation = async (number) => {
  const endpoint = `${BASE_URL}/whatsapp-conversation`;
  const email_bk = process.env.EMAIL_TOKEN;
  try {
    const response = await axios.get(endpoint, { params: { email:email_bk,number } });
    let history = [];
    const ItemConversation = response.data.item ? response.data.item.slice(-10) : [];
    let counter = 0;
     ItemConversation.forEach(item => {
        counter++
        if(counter <= 10){
          history.push({
              role: 'user',
              content: item.message_user
          });
          history.push({
            role: 'assistant',
            content: item.message_openia
          });
        }
    });

    return history;
  } catch (error) {
    defaultLogger.error('Error consultando conversaciones', {
      error: error.message,
      stack: error.stack,
      action: 'get_whatsapp_conversation_error',
      file: 'aws/index.js'
    });
    return null;
  }
};

/**
 * Obtiene los créditos disponibles
 * @returns {Promise<number|null>} Cantidad de créditos o null si hay error
 */
const getWhatsappCredit = async () => {
  const endpoint = `${BASE_URL}/whatsapp-setting/credits`;
  const email_bk = process.env.EMAIL_TOKEN;

  try {
    const response = await axios.get(endpoint, { params: { email_bk } });
    return response.data.item.credit;
  } catch (error) {
    defaultLogger.error('Error consultando créditos', {
      error: error.message,
      stack: error.stack,
      action: 'get_whatsapp_credit_error',
      file: 'aws/index.js'
    });
    return null;
  }
};



/**
 * Obtiene los créditos disponibles
 * @returns {Promise<number|null>} Cantidad de créditos o null si hay error
 */
const getWhatsappPlanPremiun = async () => {
  const endpoint = `${BASE_URL}/whatsapp-setting/credits`;
  const email_bk = process.env.EMAIL_TOKEN;

  try {
    const response = await axios.get(endpoint, { params: { email_bk } });
    return {isPremiun:response.data.item.premiun,plan:response.data.item.plan};
  } catch (error) {
    defaultLogger.error('Error consultando plan', {
      error: error.message,
      stack: error.stack,
      action: 'get_whatsapp_plan_premiun_error',
      file: 'aws/index.js'
    });
    return null;
  }
};



/**
 * Verifica si un número de teléfono está en la lista blanca
 * @param {string} phone - Número a verificar
 * @returns {Promise<boolean|null>} true si está en la lista, false si no, null si hay error
 */
const getWhatsappWhitelist = async (phone) => {
  const endpoint = `${BASE_URL}/whatsapp-sessions-whitelist`;
  const email_bk = process.env.EMAIL_TOKEN;

  try {
    const response = await axios.get(endpoint, { params: { email_bk } });
    const isWhitelisted = response.data.item.whitelist.includes(phone);
    return isWhitelisted;
  } catch (error) {
    defaultLogger.error('Error verificando whitelist', {
      phone,
      error: error.message,
      stack: error.stack,
      action: 'get_whatsapp_whitelist_error',
      file: 'aws/index.js'
    });
    return null;
  }
};

/**
 * Obtiene información de un número de WhatsApp
 * @param {string} number - Número a consultar
 * @returns {Promise<Object|null>} Datos del número o null si hay error
 */
const getWhatsapp = async (number) => {
  const endpoint = `${BASE_URL}/whatsapp`;
  const email = process.env.EMAIL_TOKEN;

  try {
    const response = await axios.get(endpoint, { params: { number, email } });
    return response.data;
  } catch (error) {
    defaultLogger.error('Error obteniendo información de WhatsApp', {
      number,
      error: error.message,
      stack: error.stack,
      action: 'get_whatsapp_error',
      file: 'aws/index.js'
    });
    return null;
  }
};

/**
 * Actualiza el estado de un número de WhatsApp
 * @param {string} number - Número a actualizar
 * @param {string} name - Nombre del usuario
 * @param {boolean} status - Estado a establecer
 * @returns {Promise<Object|null>} Respuesta de la API o null si hay error
 */
const putWhatsapp = async (number, name, status) => {
  const endpoint = `${BASE_URL}/whatsapp`;
  const email = process.env.EMAIL_TOKEN;

  try {
    const response = await axios.post(endpoint, {
      email,
      name,
      number,
      status
    });
    return response.data;
  } catch (error) {
    defaultLogger.error('Error actualizando estado de WhatsApp', {
      number,
      name,
      status,
      error: error.message,
      stack: error.stack,
      action: 'put_whatsapp_error',
      file: 'aws/index.js'
    });
    return null;
  }
};

/**
 * Envía notificación por email al vendedor
 * @param {string} number - Número del cliente
 * @param {string} name - Nombre del cliente
 * @param {string} message - Mensaje del cliente
 * @returns {Promise<boolean|null>} true si se envió correctamente, false si no, null si hay error
 */
const putWhatsappEmailVendor = async (number, name, message,image="") => {
  const endpoint = `${BASE_URL}/whatsapp-email-vendor`;
  const email_token = process.env.EMAIL_TOKEN;

  try {
    const response = await axios.post(endpoint, {
      number,
      email_token,
      name,
      message,
      image
    });
    return response.data.statusCode === 200;
  } catch (error) {
    defaultLogger.error('Error enviando notificación al vendedor', {
      number,
      name,
      error: error.message,
      stack: error.stack,
      action: 'put_whatsapp_email_vendor_error',
      file: 'aws/index.js'
    });
    return null;
  }
};

/**
 * Verifica si un mensaje contiene palabras clave de alarma
 * @param {string} message - Mensaje a verificar
 * @returns {Promise<boolean|null>} true si contiene alarmas, false si no, null si hay error
 */
const regexAlarm = async (message) => {
  const endpoint = `${BASE_URL}/whatsapp-sessions-alarm/regex`;
  const email_token = process.env.EMAIL_TOKEN;

  try {
    const response = await axios.post(endpoint, {
      email_token,
      message
    });
    return response.data.statusCode === 200;
  } catch (error) {
    defaultLogger.error('Error verificando alarmas', {
      error: error.message,
      stack: error.stack,
      action: 'regex_alarm_error',
      file: 'aws/index.js'
    });
    return null;
  }
};

/**
 * Registra una confirmación de orden
 * @param {string} name - Nombre del cliente
 * @param {string} phone - Número del cliente
 * @param {string} message - Detalles de la orden
 * @param {string} status - Estado de la orden
 * @returns {Promise<Object|null>} Respuesta de la API o null si hay error
 */
const putWhatsappOrderConfirmation = async (name, phone, message, status) => {
  const endpoint = `${BASE_URL}/whatsapp-order`;
  const email = process.env.EMAIL_TOKEN;

  // Genera número de orden con formato ddMMyyHHmm-phone
  const now = new Date();
  const formattedDate = [
    String(now.getDate()).padStart(2, '0'),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getFullYear()).slice(-2),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0')
  ].join('');
  
  const order_number = `${formattedDate}-${phone}`;

  const { runAnalyzeText } = require('../openai');

  // Analizar y estandarizar el mensaje de la orden
  try {
    const analyzedMessage = await runAnalyzeText(message);
    if (analyzedMessage) {
      message = analyzedMessage;
    }
    defaultLogger.info('Mensaje de orden analizado', {
      originalMessage: message,
      analyzedMessage,
      action: 'analyze_order_message',
      file: 'aws/index.js'
    });


    // Notificar al vendedor sobre el nuevo comprobante
    const responseAlarm = await putWhatsappEmailVendor(
      phone,
      name,
      "Información capturada del usuario: \n\n"+message
    )

    if(responseAlarm){
      defaultLogger.info('Notificación enviada al negocio', {
          phone,
          name,
          responseAlarm,
          action: 'vendor_notification_sent',
          file: 'aws/index.js'
      })
    }


  } catch (error) {
    defaultLogger.error('Error analizando mensaje de orden', {
      message,
      error: error.message,
      stack: error.stack,
      action: 'analyze_order_message_error', 
      file: 'aws/index.js'
    });
  }

  try {
    const response = await axios.post(endpoint, {
      name,
      email,
      phone,
      message,
      status,
      order_number
    });
    return response.data;
  } catch (error) {
    defaultLogger.error('Error confirmando orden', {
      name,
      phone,
      orderNumber: order_number,
      status,
      error: error.message,
      stack: error.stack,
      action: 'put_whatsapp_order_confirmation_error',
      file: 'aws/index.js'
    });
    return null;
  }
};

/**
 * Obtiene el estado global del sistema WhatsApp
 * @returns {Promise<Object|null>} Estado del sistema o null si hay error
 */
const whatsappStatus = async () => {
  const endpoint = `${BASE_URL}/whatsapp-statatus`;
  const email = process.env.EMAIL_TOKEN;

  try {
    const response = await axios.post(endpoint, { email });
    const status = JSON.parse(response.data.body);
    return status;
  } catch (error) {
    defaultLogger.error('Error obteniendo estado global', {
      error: error.message,
      stack: error.stack,
      action: 'whatsapp_status_error',
      file: 'aws/index.js'
    });
    return null;
  }
};

/**
 * Obtiene el prompt configurado para WhatsApp
 * @returns {Promise<Object|null>} Configuración del prompt o null si hay error
 */
const promptGetWhatsapp = async () => {
  const endpoint = `${BASE_URL}/whatsapp-prompt`;
  const email = process.env.EMAIL_TOKEN;

  try {
    const response = await axios.post(endpoint, { email });
    return response.data;
  } catch (error) {
    defaultLogger.error('Error obteniendo prompt', {
      error: error.message,
      stack: error.stack,
      action: 'prompt_get_whatsapp_error',
      file: 'aws/index.js'
    });
    return null;
  }
};



/**
 * Actualiza los productos y servicios en el prompt de WhatsApp
 * @param {Object} products - Objeto con los productos y servicios a actualizar
 * @returns {Promise<Object|null>} Resultado de la actualización o null si hay error
 */
const promptUpdateProductWhatsapp = async (products) => {
  const endpoint = `${BASE_URL}/whatsapp-prompt/update-prompt-product-and-services`;
  const email = process.env.EMAIL_TOKEN;

  try {
    const response = await axios.post(endpoint, { email, products });
    return response.data;
  } catch (error) {
    defaultLogger.error('Error actualizando promptUpdateProductWhatsapp', {
      error: error.message,
      stack: error.stack,
      action: 'prompt_update_products_whatsapp_error',
      file: 'aws/index.js'
    });
    return null;
  }
};

module.exports = {
  getWhatsapp,
  putWhatsapp,
  putWhatsappEmailVendor,
  putWhatsappOrderConfirmation,
  whatsappStatus,
  promptGetWhatsapp,
  regexAlarm,
  getWhatsappCredit,
  postWhatsappCredit,
  postWhatsappConversation,
  getWhatsappWhitelist,
  promptUpdateProductWhatsapp,
  getWhatsappConversation,
  getWhatsappPlanPremiun
};
