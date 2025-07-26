import { GoogleGenAI, GenerateContentResponse } from "@google/genai";
import { Translate } from "@google-cloud/translate/build/src/v2";
import { SYSTEM_PROMPTS } from "../src/constants";
import { Language, Role, Message } from "../src/types";

// Initialize AI and Translate clients
const genAI = new GoogleGenAI(process.env.GEMINI_API_KEY || "");
const translateClient = new Translate();

// --- Translation helpers ---
const getLanguageCode = (lang: Language): string => {
  const codes: Record<Language, string> = {
    English: "en",
    Somali: "so",
    Spanish: "es",
    French: "fr",
    Arabic: "ar",
  };
  return codes[lang] || "en";
};

const translateToUserLang = async (
  text: string,
  targetLang: Language
): Promise<string> => {
  const code = getLanguageCode(targetLang);
  if (!code || code === "en") return text;
  const [translated] = await translateClient.translate(text, code);
  return translated;
};

const translateToEnglish = async (
  text: string,
  sourceLang: Language
): Promise<string> => {
  const code = getLanguageCode(sourceLang);
  if (!code || code === "en") return text;
  const [translated] = await translateClient.translate(text, "en");
  return translated;
};

const generateChatName = async (
  firstMessage: string,
  lang: Language
): Promise<string> => {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const prompt = `Summarize the following user query into a short, 3-5 word chat title. Respond in the language "${lang}". Query: "${firstMessage}"`;

    const response: GenerateContentResponse = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { systemInstruction: "You are a title generator." },
    });

    return response.response.text().replace(/["'.]/g, "");
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

console.log("✅ Handler started. Env key:", process.env.GEMINI_API_KEY);

  if (!process.env.GEMINI_API_KEY) {
    return new Response(JSON.stringify({ error: "GEMINI_API_KEY is not configured" }), { status: 500 });
  }

  try {
    const body = await req.json();
    const {
      messages,
      language,
      conversationName,
      authenticatedUser,
    }: {
      messages: Message[];
      language: Language;
      conversationName?: string;
      authenticatedUser?: boolean;
    } = body;

    const userMessages = messages.filter((m) => m.role === Role.User);
    const lastUserMessage = userMessages[userMessages.length - 1]?.text ?? "";

    const translatedMessages = await Promise.all(
      messages.map(async (msg) => ({
        role: msg.role === Role.User ? "user" : "model",
        parts: [
          {
            text:
              msg.role === Role.User
                ? await translateToEnglish(msg.text, msg.language)
                : msg.text,
          },
        ],
      }))
    );

    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      generationConfig: {
        temperature: 0.7,
      },
      systemInstruction: {
        role: "system",
        parts: [{ text: SYSTEM_PROMPTS.chat(language) }],
      },
    });

    const result = await model.generateContent({
      contents: translatedMessages,
    });

    const englishResponse = result.response.text();
    const translatedResponse = await translateToUserLang(
      englishResponse,
      language
    );

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
    console.error("ERROR in /api/sendMessage:", err);
    return new Response(JSON.stringify({ error: "Internal Server Error" }), {
      status: 500,
    });
  }
}
