# 使用官方的 Node.js 18 镜像作为基础
FROM node:18-slim

# 在容器中创建一个工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json 文件
COPY package*.json ./

# 安装项目依赖
RUN npm install

# 将项目的所有文件复制到工作目录
COPY . .

# 暴露程序运行的端口
EXPOSE 3000

# 启动应用的命令
CMD [ "node", "index.js" ]
