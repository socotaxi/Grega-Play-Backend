import webpush from "web-push";

const keys = webpush.generateVAPIDKeys();
console.log("VAPID PUBLIC KEY:", keys.publicKey);
console.log("VAPID PRIVATE KEY:", keys.privateKey);
