const { addKeyword } = require('@bot-whatsapp/bot')
const { putWhatsapp,promptGetWhatsapp,whatsappStatus,getWhatsapp,postWhatsappConversation } = require('../services/aws');

const welcome =  addKeyword(["buenas","hola","como esta","buenos"])
.addAction(async (ctx, { flowDynamic,endFlow,state }) => {
    try{
        await state.update({history: []})

        const numberPhone = ctx.from
        const name = ctx?.pushName ?? ''

        await putWhatsapp(numberPhone,name,true)

        const getWhatsappPrompt = await promptGetWhatsapp();
        await postWhatsappConversation(numberPhone,ctx.body,getWhatsappPrompt.welcome);

        await flowDynamic(getWhatsappPrompt.welcome) 
    
        if(!getWhatsappPrompt.url_menu || getWhatsappPrompt.url_menu === "" || getWhatsappPrompt.url_menu === "NA"){

            await flowDynamic([
                {
                    body:getWhatsappPrompt.products
                }
            ]) 
        }else{

            await flowDynamic([
                {
                    body:'.',
                    media: getWhatsappPrompt.url_menu
                }
            ]) 
        }
        
    }catch(err){
        console.log(`[ERROR]:`,err)
    }
})

module.exports = { welcome };
