const axios = require('axios');

/**
 * 
 * @param {string} number 
 * @returns {Promise<WhatsappResponse | null>}
 */
const getWhatsapp = async (number) => {
  const endpoint = 'https://c0jkurvt19.execute-api.us-east-1.amazonaws.com/DEV/whatsapp';
  
  try {
    const response = await axios.get(endpoint, {
      params: { number }
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
  
  try {
    const response = await axios.post(endpoint, {
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
const putWhatsappEmailVendor = async (number) => {
  const endpoint = 'https://c0jkurvt19.execute-api.us-east-1.amazonaws.com/DEV/whatsapp-email-vendor';
  
  try {
    const response = await axios.post(endpoint, {
      number
    });
    
    return response.data;
  } catch (error) {
    console.log("Error putWhatsappEmailVendor :" + error);
    return null;
  }
};

/**
 * 
 * @param {string} phone 
 * @param {string} message 
 * @param {string} status 
 * @returns {Promise<WhatsappResponse | null>}
 */
const putWhatsappOrderConfirmation = async (phone, message, status) => {
  const endpoint = 'https://c0jkurvt19.execute-api.us-east-1.amazonaws.com/DEV/whatsapp-order';
  
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

module.exports = {
  getWhatsapp,
  putWhatsapp,
  putWhatsappEmailVendor,
  putWhatsappOrderConfirmation
};
