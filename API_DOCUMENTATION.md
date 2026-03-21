# Vybeme Backend API Documentation

## Base URL
```
http://localhost:8000/api
```

## Authentication
All protected routes require JWT token in Authorization header:
```
Authorization: Bearer <access_token>
```

## API Endpoints

### 1. Authentication APIs

#### Send OTP
- **POST** `/auth/send-otp`
- Body: `{ phone_number: string }`
- Response: `{ otp_id, expires_at }`
- Note: OTP is logged in backend console

#### Verify OTP
- **POST** `/auth/verify-otp`
- Body: `{ phone_number, otp_code, otp_id }`
- Response: `{ user_id, session_id, is_new_user, access_token, refresh_token }`

#### Resend OTP
- **POST** `/auth/resend-otp`
- Body: `{ phone_number }`
- Response: `{ otp_id }`

#### Get Session
- **GET** `/auth/session?session_id=xxx`
- Response: `{ user_id, session_state, session_count_this_week }`

#### Logout
- **POST** `/auth/logout`
- Body: `{ session_id }`

#### Refresh Token
- **POST** `/auth/refresh-token`
- Body: `{ refresh_token }`
- Response: `{ access_token }`

---

### 2. User Profile APIs

#### Get Current User
- **GET** `/user/me?session_id=xxx`
- Response: User profile object

#### Get User Profile
- **GET** `/user/profile/:user_id`
- Response: Public profile object

#### Update Profile
- **POST** `/user/update`
- Body: `{ session_id, name?, profile_image?, bio?, gender? }`

#### Delete User
- **DELETE** `/user/delete`
- Body: `{ session_id }`

#### Register Device Token
- **POST** `/user/device-token`
- Body: `{ device_id, push_token, platform, session_id? }`

---

### 3. Category & Tag APIs

#### Get Categories
- **GET** `/tags/categories`
- Response: `[{ tag_id, tag_name, sub_tags[] }]`

#### Get Sub-tags
- **GET** `/tags/sub-tags/:tag_id`
- Response: `{ sub_tags }`

---

### 4. Home Feed APIs

#### Get Home Feed
- **POST** `/feed/home`
- Body: `{ user_id, filters: { category_main?, category_sub[]?, location? }, pagination: { limit, offset } }`
- Response: `[PostCardFeed]`

#### Refresh Feed
- **GET** `/feed/refresh?user_id=xxx`
- Response: New posts array

#### Get Post
- **GET** `/feed/post/:post_id`
- Response: Full post object

---

### 5. Regular Post APIs

#### Create Post
- **POST** `/post/create` (Auth required)
- Body: BasePost fields
- Response: `{ post_id }`

#### Update Post
- **PUT** `/post/update/:post_id` (Auth required)
- Body: Updated fields

#### Delete Post
- **DELETE** `/post/delete/:post_id` (Auth required)

#### Get Post Details
- **GET** `/post/details/:post_id`
- Response: Full regular post

#### Get Post Analytics
- **GET** `/post/analytics/:post_id` (Auth required)
- Response: Analytics object

---

### 6. Business Post APIs

#### Create Business Post
- **POST** `/business/post/create` (Auth required)
- Body: BasePost + business fields
- Response: `{ post_id }`

#### Update Business Post
- **PUT** `/business/post/update/:post_id` (Auth required)

#### Get Business Post Details
- **GET** `/business/post/details/:post_id`

#### Get Registrations
- **GET** `/business/post/registrations/:post_id` (Auth required)
- Response: Registration analytics

#### Export CSV
- **GET** `/business/csv/export/:post_id` (Auth required)
- Response: `{ csv_export_url }`

---

### 7. Repost APIs

#### Create Repost
- **POST** `/repost/create` (Auth required)
- Body: `{ original_post_id, added_content, repost_author_id }`
- Response: `{ repost_id }`

#### Get Repost Details
- **GET** `/repost/details/:repost_id`

#### Get User Reposts
- **GET** `/repost/list/:user_id`

#### Check Repost Rules
- **POST** `/repost/rules/check`
- Body: `{ original_post_id }`
- Response: `{ can_repost: boolean }`

---

### 8. Post Interaction APIs

#### Add Comment
- **POST** `/post/comment` (Auth required)
- Body: `{ post_id, user_id, text }`
- Response: `{ comment_id }`

#### Get Comments
- **GET** `/post/comments/:post_id`
- Response: Comments array

#### Delete Comment
- **DELETE** `/post/comment/delete/:comment_id` (Auth required)

#### Add Reaction
- **POST** `/post/react` (Auth required)
- Body: `{ post_id, user_id, emoji_type }`

#### Get Reactions
- **GET** `/post/reactions/:post_id`
- Response: Reactions array

#### Create Join Request
- **POST** `/post/join` (Auth required)
- Body: `{ post_id, user_id, message? }`
- Response: `{ request_id }`

#### Get Join Requests
- **GET** `/post/join/requests/:post_id` (Auth required)
- Response: Join requests array

#### Approve Join Request
- **POST** `/post/join/approve` (Auth required)
- Body: `{ request_id }`

#### Reject Join Request
- **POST** `/post/join/reject` (Auth required)
- Body: `{ request_id }`

---

### 9. Chat APIs

#### Create Group
- **POST** `/chat/group/create` (Auth required)
- Body: `{ post_id, created_by, member_ids[] }`
- Response: `{ group_id }`

#### Get Group Details
- **GET** `/chat/group/details/:group_id` (Auth required)

#### Add Members
- **POST** `/chat/group/add-members` (Auth required)
- Body: `{ group_id, member_ids[] }`

#### Remove Member
- **POST** `/chat/group/remove-member` (Auth required)
- Body: `{ group_id, user_id }`

#### Set Announcement Group
- **POST** `/chat/group/announcement` (Auth required)
- Body: `{ group_id, is_announcement_group }`

#### Send Message
- **POST** `/chat/send` (Auth required)
- Body: `{ group_id, user_id, type, content }`
- Response: `{ message_id }`

#### Get Messages
- **GET** `/chat/messages/:group_id` (Auth required)
- Response: Messages array

#### Delete Message
- **DELETE** `/chat/message/delete/:message_id` (Auth required)

#### Create Poll
- **POST** `/chat/poll/create` (Auth required)
- Body: `{ group_id, question, options[], user_id }`
- Response: `{ poll_id }`

#### Vote in Poll
- **POST** `/chat/poll/vote` (Auth required)
- Body: `{ poll_id, user_id, option_id }`

#### Get Poll Results
- **GET** `/chat/poll/results/:poll_id` (Auth required)

---

### 10. Invite & Guest Access APIs

#### Generate Invite
- **POST** `/invite/generate` (Auth required)
- Body: `{ post_id, group_id?, created_by, scope, allow_guest, max_uses? }`
- Response: `{ invite_id, token }`

#### Resolve Invite
- **POST** `/invite/resolve`
- Body: `{ token }`
- Response: Invite data

#### Guest Enter Name
- **POST** `/invite/guest/enter-name`
- Body: `{ invite_id, guest_name }`
- Response: `{ guest_id }`

#### Guest Join
- **POST** `/invite/guest/join`
- Body: `{ invite_id, guest_id }`
- Response: `{ group_id }`

---

### 11. Notification APIs

#### Get Notifications
- **GET** `/notifications/list?user_id=xxx` (Auth required)
- Response: Notifications array

#### Mark as Read
- **POST** `/notifications/mark-read` (Auth required)
- Body: `{ notification_id }`

#### Get Unread Count
- **GET** `/notifications/counter?user_id=xxx` (Auth required)
- Response: `{ unread_count }`

---

### 12. Weekly Summary APIs

#### Get Weekly Summary
- **GET** `/weekly/summary?user_id=xxx` (Auth required)
- Response: Weekly summary object

#### Dismiss Weekly Summary
- **POST** `/weekly/dismiss` (Auth required)
- Body: `{ user_id }`

---

### 13. Event Poll APIs

#### Get Current Poll
- **GET** `/event-poll/current?user_id=xxx` (Auth required)
- Response: `{ poll_id, title, options[] }`

#### Vote in Poll
- **POST** `/event-poll/vote` (Auth required)
- Body: `{ poll_id, user_id, option_id }`

#### Get Vote Status
- **GET** `/event-poll/status?user_id=xxx` (Auth required)
- Response: `{ has_voted, voted_option_id }`

#### Dismiss Poll
- **POST** `/event-poll/dismiss` (Auth required)
- Body: `{ user_id }`

---

### 14. Map APIs

#### Get Clusters
- **POST** `/map/clusters`
- Body: `{ location: { lat, long }, radius?, category_main? }`
- Response: Clusters array

#### Get Area Posts
- **POST** `/map/area-posts`
- Body: `{ cluster_id? OR area_bounds }`
- Response: Posts array

#### Get Post Locations
- **POST** `/map/post-locations`
- Body: `{ post_ids[] }`
- Response: Locations array

---

### 15. Contact Sync APIs

#### Sync Contacts
- **POST** `/contacts/sync` (Auth required)
- Body: `{ user_id, contacts: [{ name, phone }], device_id, sync_source? }`
- Response: `{ matched_users[] }`

#### Get Matched Contacts
- **GET** `/contacts/matched?user_id=xxx` (Auth required)
- Response: `{ matched_users[] }`

#### Get Friend Plans
- **GET** `/contacts/friend-plans?user_id=xxx` (Auth required)
- Response: Posts array

---

### 16. Report User APIs

#### Report User
- **POST** `/user/report` (Auth required — reporter is taken from the JWT; do not rely on `reporter_id` in body)
- Body: `{ reported_user_id, reason, post_id?, message? }`
- Response: `{ report_id, status }`

#### Get Reports (Admin)
- **GET** `/user/report/list?admin_key=xxx`
- Response: Reports array

---

### 17. Saved Posts APIs

#### Save Post
- **POST** `/post/save` (Auth required)
- Body: `{ user_id, post_id }`
- Response: `{ save_id, saved_at }`

#### Unsave Post
- **POST** `/post/unsave` (Auth required)
- Body: `{ user_id, post_id }`

#### Get Saved Posts
- **GET** `/user/saved-posts?user_id=xxx` (Auth required)
- Response: Saved posts array

---

## Socket.io Events

### Client → Server

- `join_group` - Join a chat group room
  - Data: `{ group_id }`
  
- `leave_group` - Leave a chat group room
  - Data: `{ group_id }`
  
- `send_message` - Send a chat message
  - Data: `{ group_id, type, content }`
  
- `react_to_message` - React to a message
  - Data: `{ message_id, emoji_type }`
  
- `typing` - Typing indicator
  - Data: `{ group_id, is_typing }`

### Server → Client

- `joined_group` - Confirmation of joining group
  - Data: `{ group_id }`
  
- `left_group` - Confirmation of leaving group
  - Data: `{ group_id }`
  
- `new_message` - New message received
  - Data: Message object
  
- `message_reaction_updated` - Message reaction updated
  - Data: `{ message_id, reactions[] }`
  
- `user_joined` - User joined group
  - Data: `{ user_id, group_id }`
  
- `user_typing` - User typing indicator
  - Data: `{ user_id, is_typing }`
  
- `error` - Error occurred
  - Data: `{ message }`

### Socket Connection

Connect with authentication token:
```javascript
const socket = io('http://localhost:8000', {
  auth: {
    token: 'your_access_token'
  }
});
```

---

## Business Analytics APIs (authenticated)

All analytics endpoints require the caller to be the business/event owner.

### Per-event analytics
- **GET** `/analytics/business/event/:plan_id`
- Auth: Bearer token; user must be the event organizer (plan’s `user_id` or `business_id`).
- Response (in `data`):
  - `registered_count`, `checked_in_count`, `showup_rate`, `showup_rate_percent`
  - `first_timers_count`, `returning_count`, `first_timers_percent`, `returning_percent`
  - `revenue`, `gender_distribution` (male, female, other), `gender_distribution_percent`

### Overall analytics (e.g. last N months)
- **GET** `/analytics/business/overall?months=1`
- Auth: Bearer token; uses token’s `user_id` as business owner.
- Query: `months` (default 1, max 12).
- Response (in `data`): same metrics aggregated over all events created in the last N months, plus `per_event[]` with per-event summary (plan_id, title, registered_count, checked_in_count, showup_rate_percent, revenue).

Metrics definitions:
- **Showup rate**: # checked in / # registered (per event or overall).
- **% First timers**: # users who registered for the first time on this business’s events / total registered.
- **% Returning**: # users who registered more than once on this business’s events / total registered.
- **Revenue**: sum of `price_paid` from registrations.
- **Gender distribution**: Male, Female, Others (from user profile).

---

## Error Responses

All errors follow this format:
```json
{
  "success": false,
  "message": "Error message"
}
```

Status codes:
- `200` - Success
- `201` - Created
- `400` - Bad Request
- `401` - Unauthorized
- `403` - Forbidden
- `404` - Not Found
- `500` - Internal Server Error

---

## Notes

1. OTP is logged in backend console (not sent via SMS)
2. JWT tokens expire: Access token (15 min), Refresh token (7 days)
3. Socket.io supports guest connections (without auth)
4. All timestamps are in ISO 8601 format
5. Pagination defaults: limit=10, offset=0

