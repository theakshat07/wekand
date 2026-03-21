const { ChatMessage, User } = require('../models');
const { generateId } = require('../utils');

/**
 * WhatsApp-style system line when someone is added to a group.
 * Used by POST /chat/group/add-members and by registration/payment flows.
 */
async function postMemberAddedSystemMessage(group_id, addedUserId) {
  const uid = String(addedUserId);
  const addedUser = await User.findOne({ user_id: uid }).lean();
  const addedName = addedUser?.name || 'Someone';
  const addedImage = addedUser?.profile_image || null;
  await ChatMessage.create({
    message_id: generateId('msg'),
    group_id,
    user_id: uid,
    type: 'system',
    content: {
      text: `${addedName} joined the group`,
      added_user_id: uid,
      added_user_name: addedName,
      added_user_profile_image: addedImage,
    },
    reactions: [],
  });
}

/**
 * Normalize member ids (strings), add if missing, persist, then system message.
 * @returns {{ added: boolean }}
 */
async function addMemberToChatGroupIfNeeded(group, userId) {
  const uid = String(userId);
  if (!group.members) group.members = [];
  const already = group.members.some((m) => String(m) === uid);
  if (already) {
    return { added: false };
  }
  group.members.push(uid);
  await group.save();
  await postMemberAddedSystemMessage(group.group_id, uid);
  return { added: true };
}

module.exports = {
  postMemberAddedSystemMessage,
  addMemberToChatGroupIfNeeded,
};
