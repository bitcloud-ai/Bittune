export function modelMessage(message:{content?:string|null;reasoning_content?:string;reasoning?:string}) {
 const raw=message.content || "",end=raw.indexOf("</think>");
 if(end>=0)return {content:raw.slice(end+8).trim(),reasoning:message.reasoning_content || message.reasoning || raw.slice(0,end).replace(/^\s*<think>\s*/,"").trim()};
 if(/^\s*<think>/.test(raw))return {content:"",reasoning:raw.replace(/^\s*<think>\s*/,"").trim()};
 return {content:raw.trim(),reasoning:message.reasoning_content || message.reasoning};
}
