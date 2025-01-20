const axios = require('axios');
require('dotenv').config();



/**
 * 
 * @returns {Promise<WhatsappResponse | null>}
 */
const postWhatsappCredit = async (credit) => {
  const email_bk = process.env.EMAIL_TOKEN;
  const endpoint = 'https://c0jkurvt19.execute-api.us-east-1.amazonaws.com/DEV/whatsapp-setting/credits?email_bk='+email_bk;

  try {
    const response = await axios.post(endpoint, {
      credit
    });
    
    return response.data;
  } catch (error) {
    console.log("Error postWhatsappCredit :" + error);
    return null;
  }
};


/**
 * 
 * @returns {Promise<WhatsappResponse | null>}
 */
const postWhatsappConversation = async (phone,message_user,message_openia) => {
  const email_bk = process.env.EMAIL_TOKEN;
  const endpoint = 'https://c0jkurvt19.execute-api.us-east-1.amazonaws.com/DEV/whatsapp-conversation?email_bk='+email_bk;
  try {
    const response = await axios.post(endpoint, {
      phone,
      message_user,
      message_openia
    });
    
    return response.data;
  } catch (error) {
    console.log("Error postWhatsappCredit :" + error);
    return null;
  }
};


/**
 * 
 * @returns {Promise<WhatsappResponse | null>}
 */
const getWhatsappCredit = async () => {
  const endpoint = 'https://c0jkurvt19.execute-api.us-east-1.amazonaws.com/DEV/whatsapp-setting/credits';
  const email_bk = process.env.EMAIL_TOKEN;

  try {
    const response = await axios.get(endpoint, {
      params: { email_bk }
    });
    
    return response.data.item.credit;
  } catch (error) {
    console.log("Error getWhatsappCredit :" + error);
    return null;
  }
};


function containsPhoneValue(inputString, phone) {
  return inputString.includes(phone);
}

/**
 * 
 * @returns {Promise<WhatsappResponse | null>}
 */
const getWhatsappWhitelist = async (phone) => {
  const endpoint = 'https://c0jkurvt19.execute-api.us-east-1.amazonaws.com/DEV/whatsapp-sessions-whitelist';
  const email_bk = process.env.EMAIL_TOKEN;

  try {
    const response = await axios.get(endpoint, {
      params: { email_bk }
    });

    if (containsPhoneValue(response.data.item.whitelist, phone)) {
      return true
    } 
    return false;
  } catch (error) {
    console.log("Error getWhatsappWhitelist :" + error);
    return null;
  }
};

/**
 * 
 * @param {string} number 
 * @returns {Promise<WhatsappResponse | null>}
 */
const getWhatsapp = async (number) => {
  const endpoint = 'https://c0jkurvt19.execute-api.us-east-1.amazonaws.com/DEV/whatsapp';
  const email = process.env.EMAIL_TOKEN;

  try {
    const response = await axios.get(endpoint, {
      params: { number,email }
    });
    
    return response.data;
  } catch (error) {
    console.log("Error getWhatsapp :" + error);
    return null;
  }
};

/**
 * 
 * @param {string} number 
 * @param {string} name 
 * @param {boolean} status 
 * @returns {Promise<WhatsappResponse | null>}
 */
const putWhatsapp = async (number, name, status) => {
  const endpoint = 'https://c0jkurvt19.execute-api.us-east-1.amazonaws.com/DEV/whatsapp';
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
    console.log("Error putWhatsapp :" + error);
    return null;
  }
};

/**
 * 
 * @param {string} number 
 * @returns {Promise<WhatsappResponse | null>}
 */
const putWhatsappEmailVendor = async (number,name,message) => {
  const endpoint = 'https://c0jkurvt19.execute-api.us-east-1.amazonaws.com/DEV/whatsapp-email-vendor';
  const email_token = process.env.EMAIL_TOKEN;

  try {
    const response = await axios.post(endpoint, {
      number,
      email_token,
      name,
      message
    });
    
    return (response.data.statusCode === 200) ? true : false;
  } catch (error) {
    console.log("Error putWhatsappEmailVendor :" , error);
    return null;
  }
};


/**
 * 
 * @param {string} message 
 * @returns {Promise<WhatsappResponse | null>}
 */
const regexAlarm = async (message) => {
  const endpoint = 'https://c0jkurvt19.execute-api.us-east-1.amazonaws.com/DEV/whatsapp-sessions-alarm/regex';
  const email_token = process.env.EMAIL_TOKEN;

  try {
    const response = await axios.post(endpoint, {
      email_token,
      message
    });    
    return (response.data.statusCode === 200) ? true : false;
  } catch (error) {
    console.log("Error regexAlarm :" , error);
    return null;
  }
};

/**
 * 
 * @param {string} name 
 * @param {string} phone 
 * @param {string} message 
 * @param {string} status 
 * @returns {Promise<WhatsappResponse | null>}
 */
const putWhatsappOrderConfirmation = async (name,phone, message, status) => {
  const endpoint = 'https://c0jkurvt19.execute-api.us-east-1.amazonaws.com/DEV/whatsapp-order';
  const email = process.env.EMAIL_TOKEN;

  // Obtener la fecha y hora actual
  const now = new Date();

  // Formatear la fecha y hora en el formato ddMMyyHHmm
  const formattedDate = 
      ('0' + now.getDate()).slice(-2) +           // Día (dd)
      ('0' + (now.getMonth() + 1)).slice(-2) +    // Mes (mm)
      String(now.getFullYear()).slice(-2) +       // Año (yy)
      ('0' + now.getHours()).slice(-2) +          // Hora (HH)
      ('0' + now.getMinutes()).slice(-2); 
  
  const order_number = formattedDate + "-" + phone;
  
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
    console.log("Error putWhatsappOrderConfirmation :" + error);
    return null;
  }
};

/**
 * 
 * @param {string} any 
 * @returns {Promise<WhatsappResponse | null>}
 */
const whatsappStatus = async () => {
  const endpoint = 'https://c0jkurvt19.execute-api.us-east-1.amazonaws.com/DEV/whatsapp-statatus';
  const email = process.env.EMAIL_TOKEN;
  try {
    const response = await axios.post(endpoint, {
      email:email
    });
    return JSON.parse(response.data.body);
  } catch (error) {
    console.log("Error getWhatsappStatus :" + error);
    return null;
  }
};

/**
 * 
 * @param {string} any 
 * @returns {Promise<WhatsappResponse | null>}
 */
const promptGetWhatsapp= async () => {
  const endpoint = 'https://c0jkurvt19.execute-api.us-east-1.amazonaws.com/DEV/whatsapp-prompt';
  const email = process.env.EMAIL_TOKEN;
  
  try {
    const response = await axios.post(endpoint, {
      email:email
    });
    return JSON.parse(response.data.body);
  } catch (error) {
    console.log("Error getWhatsappPrompt :" + error);
    return null;
  }
};

const test= async () => {
  const endpoint = 'https://c0jkurvt19.execute-api.us-east-1.amazonaws.com/DEV/whatsapp-prompt';
  const email = process.env.EMAIL_TOKEN;
  
  try {
    const response = await axios.post(endpoint, {
      email:email
    });
    return response.data;
  } catch (error) {
    console.log("Error getWhatsappPrompt :" + error);
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
  getWhatsappWhitelist
};
