const crypto = require("crypto");

const MIN_PASSWORD_LENGTH = Number(process.env.MIN_PASSWORD_LENGTH) || 10;
const DEFAULT_ONE_TIME_PASSWORD_LENGTH = Math.max(
  Number(process.env.ONE_TIME_PASSWORD_LENGTH) || 16,
  MIN_PASSWORD_LENGTH,
  12
);
const ONE_TIME_PASSWORD_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ONE_TIME_PASSWORD_DIGITS = "23456789";
const ONE_TIME_PASSWORD_ALPHABET = `${ONE_TIME_PASSWORD_LETTERS}${ONE_TIME_PASSWORD_DIGITS}`;

function getPasswordValidationError(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen lang sein.`;
  }
  const hasLetter = /[A-Za-z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  if (!hasLetter || !hasNumber) {
    return "Passwort muss mindestens einen Buchstaben und eine Zahl enthalten.";
  }
  return null;
}

function pickRandomChar(alphabet) {
  return alphabet[crypto.randomInt(0, alphabet.length)];
}

function shuffleCharacters(characters) {
  const result = [...characters];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(0, index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result.join("");
}

function generateOneTimePassword(length = DEFAULT_ONE_TIME_PASSWORD_LENGTH) {
  const safeLength = Math.max(Number(length) || DEFAULT_ONE_TIME_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, 12);
  const characters = [
    pickRandomChar(ONE_TIME_PASSWORD_LETTERS),
    pickRandomChar(ONE_TIME_PASSWORD_DIGITS)
  ];

  while (characters.length < safeLength) {
    characters.push(pickRandomChar(ONE_TIME_PASSWORD_ALPHABET));
  }

  return shuffleCharacters(characters);
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  DEFAULT_ONE_TIME_PASSWORD_LENGTH,
  getPasswordValidationError,
  generateOneTimePassword
};
