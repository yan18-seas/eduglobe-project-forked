import { GoogleGenAI, GenerateContentResponse } from "@google/genai";
import { Translate } from "@google-cloud/translate/build/src/v2";
import { Language, Role, Message } from "../src/types";
import { SYSTEM_PROMPTS } from "../src/constants";

// This is a Vercel Serverless Function, which acts as our secure backend.

const generateChatName = async (firstMessage: string, lang: Language, ai: GoogleGenAI): Promise<string> => {
    try {
        const prompt = `Summarize the following user query into a short, 3-5 word chat title. Respond in the language "${lang}". Query: "${firstMessage}"`;
        const response: GenerateContentResponse = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: { systemInstruction: "You are a title generator." }
        });
        return response.text.replace(/["'.]/g, ''); // Clean up quotes and periods
    } catch (error) {
        console.error("Error generating chat name:", error);
        return firstMessage.substring(0, 30) + '...';
    }
};

export default async function handler(req: Request) {
    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
    }

    try {
        // --- Step 1: Initialize API Clients Securely ---
        if (!process.env.GEMINI_API_KEY) {
            return new Response(JSON.stringify({ error: "GEMINI_API_KEY is not configured on the server." }), { status: 500 });
        }
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const translateClient = new Translate({ key: process.env.GEMINI_API_KEY });

        const languageCodeMap: { [key: string]: string } = {
            [Language.ENGLISH]: 'en',
            [Language.TIBETAN]: 'bo',
            [Language.HAWAIIAN]: 'haw',
            [Language.TELUGU]: 'te',
        };
        
        const translate = async (text: string, targetLanguage: Language) => {
            const targetCode = languageCodeMap[targetLanguage];
            if (!targetCode || targetCode === 'en') { // No need to translate to English if it already is, or if no code exists
                return text;
            }
            try {
                const [translation] = await translateClient.translate(text, targetCode);
                return translation;
            } catch (error) {
                console.error("Google Cloud Translation API error:", error);
                return text; // Fallback to original text on error
            }
        };

        const untranslate = async (text: string, sourceLanguage: Language) => {
             if(sourceLanguage === Language.ENGLISH){
                 return text;
             }
             const sourceCode = languageCodeMap[sourceLanguage];
             if(!sourceCode) return text;

             try {
                const [translation] = await translateClient.translate(text, 'en');
                return translation;
             } catch(error) {
                console.error("Google Cloud Untranslation API error:", error);
                return text;
             }
        }


        // --- Step 2: (Placeholder) Real Authentication ---
        // const authHeader = req.headers.get('Authorization');
        // if (authHeader) {
        //   console.log("Authenticated user request received.");
        // } else {
        //   console.log("Guest user request received.");
        // }


        // --- Step 3: Get Data from Frontend Request ---
        const { text, language, history, generateName } = await req.json();

        // --- Step 4: Prepare Data for Gemini ---
        const englishQuery = await untranslate(text, language);
        const systemPrompt = SYSTEM_PROMPTS[language];
        
        const historyForApi = history.map(async (msg: Message) => {
             if (msg.role === Role.USER) { return { role: 'user' as const, text: await untranslate(msg.text, msg.language) }; }
             else { return { role: 'model' as const, text: msg.text }; } // AI responses are already in English
        });
        const englishHistory = await Promise.all(historyForApi);

        const contents = englishHistory.map(msg => ({
            role: msg.role,
            parts: [{ text: msg.text }]
        }));
        contents.push({ role: 'user', parts: [{ text: englishQuery }] });

        // --- Step 5: Call the Gemini API ---
        const response: GenerateContentResponse = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: contents,
            config: { systemInstruction: systemPrompt }
        });
        const aiEnglishResponse = response.text;
        const aiFinalResponse = await translate(aiEnglishResponse, language);

        // --- Step 6: Handle Optional Name Generation ---
        let chatName = null;
        if (generateName) {
            chatName = await generateChatName(text, language, ai);
        }

        // --- Step 7: Send Response to Frontend ---
        return new Response(JSON.stringify({ chatResponse: aiFinalResponse, chatName }), {
            headers: { 'Content-Type': 'application/json' },
            status: 200,
        });

    } catch (error) {
        console.error("Error in sendMessage API:", error);
        return new Response(JSON.stringify({ error: 'Failed to process request.' }), { status: 500 });
    }
}
