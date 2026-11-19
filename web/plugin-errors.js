// Coded errors the capability API returns to plugins as {code, message}.
export const failure=(code,message)=>Object.assign(new Error(message),{code});
