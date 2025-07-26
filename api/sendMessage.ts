import { GoogleGenAI } from "@google/genai";
import { SYSTEM_PROMPTS } from "../src/constants";
import { Language, Role, Message } from "../src/types";

// Set up Gemini client
const genAI = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || "",
});

// Maps supported languages to ISO codes
const getLanguageCode = (lang: Language): string => {
  const codes: Record<string, string> = {
    English: "en",
    Somali: "so",
    Spanish: "es",
    French: "fr",
    Arabic: "ar",
  };
  return codes[lang] || "en";
};

// Translate any text to target language using Google Translate REST API
const translateText = async (
  text: string,
  targetLang: Language
): Promise<string> => {
  const target = getLanguageCode(targetLang);
  if (target === "en") return text;

  const url = `https://translation.googleapis.com/language/translate/v2?key=${process.env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      q: text,
      target,
      format: "text",
    }),
  });

  const json = await res.json();
  return json?.data?.translations?.[0]?.translatedText || text;
};

// Generate a conversation title based on the first user message
const generateChatName = async (
  firstMessage: string,
  lang: Language
): Promise<string> => {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-pro" });
    const prompt = `Summarize this user query into a short, 3-5 word chat title. Reply in "${lang}": "${firstMessage}"`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    return text.replace(/["'.]/g, "");
  } catch (err) {
    console.error("Error generating chat name:", err);
    return firstMessage.slice(0, 30) + "...";
  }
};

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
    });
  }

  if (!process.env.GEMINI_API_KEY) {
    return new Response(
      JSON.stringify({ error: "GEMINI_API_KEY is not configured" }),
      { status: 500 }
    );
  }

  try {
    const body = await req.json();
    const {
      messages,
      language,
      conversationName,
    }: {
      messages: Message[];
      language: Language;
      conversationName?: string;
    } = body;

    const userMessages = messages.filter((m) => m.role === Role.USER);
    const lastUserMessage = userMessages[userMessages.length - 1]?.text ?? "";

    // Translate user messages to English
    const translatedMessages = await Promise.all(
      messages.map(async (msg) => ({
        role: msg.role === Role.USER ? "user" : "model",
        parts: [
          {
            text:
              msg.role === Role.USER
                ? await translateText(msg.text, "English")
                : msg.text,
          },
        ],
      }))
    );

    // Generate a Gemini response
    const model = genAI.getGenerativeModel({
      model: "gemini-pro",
      generationConfig: { temperature: 0.7 },
      systemInstruction: {
        role: "system",
        parts: [{ text: SYSTEM_PROMPTS.chat(language) }],
      },
    });

    const result = await model.generateContent({
      contents: translatedMessages,
    });

    const englishResponse = result.response.text();
    const translatedResponse = await translateText(englishResponse, language);

    const aiMessage: Message = {
      id: Date.now().toString(),
      role: Role.AI,
      text: translatedResponse,
      language,
    };

    let title = conversationName;
    if (!conversationName && userMessages.length === 1) {
      title = await generateChatName(lastUserMessage, language);
    }

    return new Response(
      JSON.stringify({ message: aiMessage, conversationName: title }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("Internal error:", err);
    return new Response(JSON.stringify({ error: "Internal Server Error" }), {
      status: 500,
    });
  }
}
