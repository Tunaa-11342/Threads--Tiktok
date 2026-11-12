# Threads → TikTok

Mở `Chay-tool.cmd` hoặc chạy `npm ci` rồi `npm start`, sau đó vào http://127.0.0.1:3917/. Cần Node.js 22+, Chrome và FFmpeg/FFprobe trong PATH. Tool dùng VieNeu-TTS từ `E:\24h\AI MAKE VIDEO\VieNeu-TTS\.venv\Scripts\python.exe`. Nếu chuyển thư mục VieNeu-TTS, đặt biến `VIENEU_PYTHON` tới Python của bản cài đó.

Dán link bài Threads công khai hoặc nhập tay. Khi nhập bình luận, mỗi dòng là một bình luận. Có thể thêm `| 123` cuối dòng để nhập số tim. Chọn tối đa 4 bình luận và tạo bản xem trước. Clip mở ngay với thẻ trắng chứa nội dung bài gốc. Lời đọc mặc định lấy từ nội dung gốc và có thể chỉnh theo cảnh. Clip hiển thị thẻ bài viết và bình luận, không chèn phụ đề. Có thể chọn video nền hoặc dùng nền lưới mặc định. Nút Xuất MP4 lưu đúng video đã xem vào thư mục Xuất ra. Bản nháp chữ tự lưu trong trình duyệt. Chọn lại file nền sau khi khởi động lại tool.

Lượt tim được xếp trong phần dữ liệu Threads cho trình duyệt xem. Nếu thiếu bình luận hoặc số tim, nhập bổ sung trong Nguồn Threads. Phần tạo giọng và dựng video chạy trên máy. Tool dùng Ngọc Lan nếu bản cài có preset đó, hoặc Trúc Ly nếu Ngọc Lan không có.

## Âm thanh

VieNeu-TTS nhận cả đoạn lời đọc của một cảnh trong một lần. Dùng dấu câu như viết bình thường.

Trong **Vị trí thẻ**, chọn bài viết hoặc một bình luận rồi kéo thanh Ngang và Dọc. Từng thẻ có vị trí riêng.

Chọn **Âm thanh mở đầu** trong cảnh **Mở đầu**. Hiệu ứng này phát trước lời đọc. Trong **Bình luận → Thứ tự lên video**, chọn hiệu ứng riêng sau từng bình luận. Cả hai có thể dùng file trong **Sound Effects**, dùng âm có sẵn, để tự động hoặc tắt. File tùy chọn phát tối đa 4 giây.

Thả file MP3, WAV, M4A, AAC, OGG, FLAC, Opus hoặc WMA vào thư mục Nhạc nền cạnh Chay-tool.cmd. Bấm Làm mới và chọn bài trong tool. Nhạc phát nhỏ, tự lặp và có fade đầu/cuối.
## Outro

Trong **Kết video**, bật hoặc tắt outro, đổi chữ và xem thử chuyển động. Khi xuất, tool giữ khung hình cuối của video nền, làm mờ dần rồi hiện nút Follow LapZone. Outro kéo dài 3 giây, có tiếng nhấn và tiếng báo hoàn tất.