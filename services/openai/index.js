const OpenAI = require("openai");
const { generatePrompt, generatePromptDetermine } = require("./prompt.js");
require('dotenv').config();

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

/**
 * 
 * @param {string} name 
 * @param {Array} history 
 * @returns {Promise<string>}
 */
const run = async (name, history,question) => {
    const prompt = await generatePrompt(name,question);
    const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
            {
                "role": "system",
                "content": prompt
            },
            ...history
        ],
        temperature: 1,
        max_tokens: 800,
        top_p: 1,
        frequency_penalty: 0,
        presence_penalty: 0,
    });
    return response.choices[0].message.content;
};

/**
 * 
 * @param {Array<ChatCompletionMessageParam>} history 
 * @returns {Promise<string>}
 */
const runDetermine = async (history) => {
    const prompt = generatePromptDetermine();
    const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
            {
                "role": "system",
                "content": prompt
            },
            ...history
        ],
        temperature: 1,
        max_tokens: 800,
        top_p: 1,
        frequency_penalty: 0,
        presence_penalty: 0,
    });
    return response.choices[0].message.content;
};

module.exports = { run,runDetermine };
