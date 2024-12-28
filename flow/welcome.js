const { addKeyword } = require('@bot-whatsapp/bot')
const { putWhatsapp,promptGetWhatsapp,whatsappStatus,getWhatsapp } = require('../services/aws');

const welcome =  addKeyword(["buenas","hola","como esta","menu"])
.addAction(async (ctx, { flowDynamic,endFlow,state }) => {
    try{
        await state.update({history: []})

        const numberPhone = ctx.from
        const name = ctx?.pushName ?? ''

        const getWhatsappStatus = await whatsappStatus();
        if(getWhatsappStatus && !getWhatsappStatus.status){
            console.log("Chat bot Disabled from database")
            return  endFlow();
        }

        const validateWhatsapp = await getWhatsapp(numberPhone)
        if(validateWhatsapp && !validateWhatsapp.status){
            console.log(`Chat bot Session Disabled from database : [${userId}]`)
            return  endFlow();
        }

        await putWhatsapp(numberPhone,name,true)

        const getWhatsappPrompt = await promptGetWhatsapp();

        await flowDynamic([
            {
                body:"Hola",
            }
        ]) 

        await flowDynamic(getWhatsappPrompt.welcome) 

        if(!getWhatsappPrompt.url_menu || getWhatsappPrompt.url_menu === "" || getWhatsappPrompt.url_menu === "NA"){
            await flowDynamic([
                {
                    body:'Menu: '
                }
            ]) 
            await flowDynamic([
                {
                    body:getWhatsappPrompt.products
                }
            ]) 
        }else{
            await flowDynamic([
                {
                    body:'Menu',
                    media: getWhatsappPrompt.url_menu
                }
            ]) 
        }
        
    }catch(err){
        console.log(`[ERROR]:`,err)
    }
})

module.exports = { welcome };
