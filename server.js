
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');
const bodyParser = require('body-parser');
const crypto = require('crypto'); // For hash calculation
const { Schema } = mongoose;
const os = require("os"); // Added for cross-platform temp dir
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const dotenv = require("dotenv");
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const { body, validationResult } = require('express-validator');
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const { exec } = require("child_process");
const { Upload } = require("@aws-sdk/lib-storage");
const { Readable } = require('stream');
const { Blob } = require('buffer');

// Add new dependencies at the top
const PDFDocument = require('pdfkit');
const Chart = require('chart.js');
const { createCanvas } = require('canvas');
const htmlToPdf = require('html-pdf');
const sendConsentEmail = require('./services/sendConsentMail'); // Or wherever you place it


dotenv.config();
// Initialize Express app
const app = express();
const PORT = process.env.PORT;  

// Create an HTTP server to support WebSockets
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Middleware
app.use(
  cors({
    origin: process.env.FRONTEND_URL,
    credentials: true, // needed for cookies, auth headers, etc.
  })
);




app.use(express.json());
app.use(cookieParser());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// In server.js - Replace the rate limiter setu
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));



mongoose
.connect(process.env.MONGO_URI)
.then(() => console.log("MongoDB connected"))
.catch((err) => console.error("MongoDB connection error:", err));
// Schemas
// SendGrid configuration
// Replace current multer config with memory storage:
const memoryStorage = multer.memoryStorage();

const audioUpload = multer({
  storage: memoryStorage,
  fileFilter: (req, file, cb) => {
    if (
      file.mimetype === 'audio/wav' || 
      file.mimetype === 'audio/x-wav' ||
      file.mimetype === 'audio/wave' ||
      file.originalname.match(/\.wav$/i)
    ) {
      cb(null, true);
    } else {
      cb(new Error('Only WAV audio files are allowed'), false);
    }
  },
  
}).single('audio');

const upload = multer({ storage: memoryStorage });
// User Model
const userSchema = new mongoose.Schema({
  fullName: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  mobileNumber: { type: String, required: true },
  companyName: { type: String, required: true },
  designation: { type: String, required: true },
  isEmailVerified: { type: Boolean, default: false },
  isAdmin: { type: Boolean, default: false },
  isApproved: { type: Boolean, default: false },
  // Removed isUnlimited field as it's redundant
  subscription: {
    plan: { 
      type: String, 
      enum: ['trial', 'free', 'paid', 'admin'], 
      default: 'trial',
      required: true
    },
    startedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date },
    isActive: { type: Boolean, default: true },
    // Limits only exist for trial/free users
    limits: {
      jdUploads: { type: Number },
      resumeUploads: { type: Number },
      assessments: { type: Number }
    }
  },
  usage: {
    jdUploads: { type: Number, default: 0 },
    resumeUploads: { type: Number, default: 0 },
    assessments: { type: Number, default: 0 }
  },
 
}, { timestamps: true });

const User = mongoose.model('User', userSchema);




const ResumeSchema = new Schema({
  title: String,
  s3Key: { type: String, required: true }, // Make this required
  filename: { type: String, required: true },
  uploadedAt: { type: Date, default: Date.now },
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  hash: { type: String, unique: true } // Add hash for deduplication
});

const JobDescriptionSchema = new Schema({
  title: String,
  s3Key: { type: String, required: true }, // Make this required
  filename: { type: String, required: true },
  uploadedAt: { type: Date, default: Date.now },
  hash: { type: String, unique: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true } // Added
});


const ApiResponseSchema = new Schema({
  resumeId: { type: Schema.Types.ObjectId, ref: 'Resume', required: true },
  jobDescriptionId: { type: Schema.Types.ObjectId, ref: 'JobDescription', required: true },
  matchingResult: Object,
  createdAt: { type: Date, default: Date.now },
  hash: { type: String, unique: true },
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  candidateConsent: {
    allowedToShare: { type: Boolean, default: false },
    message: { type: String },
    respondedAt: { type: Date }
  }
});

const Resume = mongoose.model('Resume', ResumeSchema);
const JobDescription = mongoose.model('JobDescription', JobDescriptionSchema);
const ApiResponse = mongoose.model('ApiResponse', ApiResponseSchema);
// Add new VoiceAnswer schema
// Update the VoiceAnswerSchema in server.js
const VoiceAnswerSchema = new mongoose.Schema({
  questionId: { type: String, required: true },
  question: { type: String, required: true },
  audioPath: { type: String, required: true }, // Will store S3 key like "audio/answer_123.webm"
  durationSec: { type: Number }, // Add duration tracking
  answered: { type: Boolean, default: false }, // Track if attempted
  skipReason: { type: String }, // Reason for skipping processing
  valid: { type: Boolean, default: false }, // Track if valid response
  transcriptionPath: { type: String }, // Will store S3 key like "transcripts/answer_123.txt"
  answer: { type: String },
  audioAnalysis: {
    grading: Object,
    processedAt: Date,
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed'],
      default: 'pending'
    }
  },
  textEvaluation: {  // New field for text evaluation
    metrics: {
      Authentic: Number,
      Clarity: Number,
      Fluency: Number,
      Focused: Number,
      NoFillers: Number,
      Professionalism: Number,
      Relevance: Number,
      StructuredAnswers: Number,
      UniqueQualities: Number,
      total_average: Number,
      total_overall_score: Number
     
    },
    processedAt: Date,
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed'],
      default: 'pending'
    }
  },
  processingStatus: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed'],
    default: 'pending'
  },
  assessmentSession: {
    type: Schema.Types.ObjectId,
    ref: 'AssessmentSession',
    required: true
  },
  createdAt: { type: Date, default: Date.now }
});

const VoiceAnswer = mongoose.model('VoiceAnswer', VoiceAnswerSchema);

// Define MongoDB schema and model
const recordingSchema = new mongoose.Schema({
  filename: String,
  videoPath: String,
  screenPath: String,
  assessmentSession: {
    type: Schema.Types.ObjectId,
    ref: 'AssessmentSession',
    required: true
  },
  videoAnalysis: {
    emotions: {
      dominant_emotion: String,
      emotion_distribution: mongoose.Schema.Types.Mixed,
      occurrence_count: Number,
      total_frames_processed: Number
    },
    video_score: Number,
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed'],
      default: 'pending'
    },
    startedAt: Date,
    completedAt: Date,
    error: String
  }
}, { timestamps: true });
const Recording = mongoose.model("Recording", recordingSchema);
// Update AssessmentSession schema
const AssessmentSessionSchema = new Schema({
  candidateEmail: { type: String, required: true },
  jobTitle: { type: String, required: true },
  testLink: { type: String, required: true },
  recording: { type: Schema.Types.ObjectId, ref: 'Recording' },
  testResult: { type: Schema.Types.ObjectId, ref: 'TestResult' },
  voiceAnswers: [{ type: Schema.Types.ObjectId, ref: 'VoiceAnswer' }],
// Update AssessmentSession schema to store user answers
questions: [{
  id: String,
  question: String,
  options: [String],
  correctAnswer: String,
  userAnswer: String // Add this field to store user's answer
}],
  voiceQuestions: [{
    id: String,
    question: String
  }],
  resumeId: { type: Schema.Types.ObjectId, ref: 'Resume' },
  jobDescriptionId: { type: Schema.Types.ObjectId, ref: 'JobDescription' },
  currentPhase: {
    type: String,
    enum: ['mcq', 'voice', 'completed'],
    default: 'mcq'
  },
  startedAt: { type: Date, default: Date.now },
  completedAt: { type: Date },
  status: { type: String, enum: ['pending', 'in-progress', 'completed'], default: 'pending' },
   user: { type: Schema.Types.ObjectId, ref: 'User', required: true }, // Added

    reportStatus: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed'],
    default: 'pending'
  },
  reportGeneratedAt: Date
  
});

console.log("✅ MongoDB Schema and Model Initialized");
const AssessmentSession = mongoose.model('AssessmentSession', AssessmentSessionSchema);
// Enhanced TestResult schema
const TestResultSchema = new Schema({
  candidateEmail: { type: String, required: true, index: true },
  jobTitle: { type: String, required: true },
  score: { type: Number, required: true }, // MCQ score
  audioScore: { type: Number }, // Average audio score
  textScore: { type: Number }, // Text evaluation score
  videoScore: { type: Number }, // Add this new field for video score
  combinedScore: { type: Number }, // Combined overall score
  assessmentSession: { type: Schema.Types.ObjectId, ref: 'AssessmentSession', required: true },
  submittedAt: { type: Date, default: Date.now },
  status: { type: String, enum: ['pending', 'completed', 'expired'], default: 'pending' },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true } // Added

}, { timestamps: true });
const TestResult = mongoose.model('TestResult', TestResultSchema);

// Add near other schemas
const ReportSchema = new mongoose.Schema({
  assessmentSession: { 
    type: Schema.Types.ObjectId, 
    ref: 'AssessmentSession',
    required: true 
  },
  s3Key: { type: String, required: true },
  filename: { type: String, required: true },
  generatedAt: { type: Date, default: Date.now },
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

const Report = mongoose.model('Report', ReportSchema);


// ==============================
// ✅ NEW SCHEMAS
// ==============================
const jobPosterSchema = new mongoose.Schema({
  name: String,
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  isVerified: { type: Boolean, default: false },
}, { timestamps: true });
const jobPostSchema = new mongoose.Schema({
  title: String,
  companyName: String, // NEW FIELD ADDED
  location: String,
  experience: String,
  jobType: String,
  department: String,
  skillsRequired: [String],
  salaryRange: String,
  jobDescriptionFile: String,
  descriptionText: String,
  publicId: { type: String, unique: true },
  applications: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Application' }],
  createdAt: { type: Date, default: Date.now },
  postedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'JobPoster' },
});

const JobPoster = mongoose.model('JobPoster', jobPosterSchema);
const JobPost = mongoose.model('JobPost', jobPostSchema);
const applicationSchema = new mongoose.Schema({
  jobId: { type: mongoose.Schema.Types.ObjectId, ref: 'JobPost', required: true },
  candidateName: { type: String, required: true },
  candidateEmail: { type: String, required: true },
  candidatePhone: String,
  resumeFile: String, // S3 key
  appliedAt: { type: Date, default: Date.now }
});

const Application = mongoose.model('Application', applicationSchema);



// ==============================
// ✅ JOB PORTAL AUTH ROUTES
// ==============================


// Add near the top with other helper functions

const outputDir = path.join(os.tmpdir(), `whisper_${Date.now()}`);

 // Create NodeMailer transporter using custom SMTP
 const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: true, // Use STARTTLS instead of direct TLS
  tls: {
    rejectUnauthorized: false // Allow self-signed certificates
  },
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});
// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET;

// Middleware to verify JWT
const authenticateJWT = (req, res, next) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ message: 'Access denied. No token provided.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: 'Invalid token.' });
    req.user = user;
    next();
  });
};

// Middleware to check if user is admin
const isAdmin = (req, res, next) => {
  if (!req.user.isAdmin) return res.status(403).json({ message: 'Admin access required.' });
  next();
};
// Modify authenticateJobPoster middleware in server.js
function authenticateJobPoster(req, res, next) {
  const token = req.cookies?.jobToken || req.headers.authorization?.split(' ')[1];
  const adminToken = req.cookies?.token || req.headers.authorization?.split(' ')[1];
  
  // First try normal HR auth
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
      return next();
    } catch (err) {
      // Continue to admin check
    }
  }
  
  // Then try admin auth
  if (adminToken) {
    try {
      const decoded = jwt.verify(adminToken, JWT_SECRET);
      if (decoded.isAdmin) {
        req.user = { isAdmin: true };
        return next();
      }
    } catch (err) {
      return res.status(403).json({ message: 'Invalid token' });
    }
  }
  
  return res.status(401).json({ message: 'Login required' });
}



const verifyOwnership = (model) => async (req, res, next) => {
  try {
 const id = req.params.resumeId || req.params.jobDescriptionId || req.params.id;

    console.log(`Verifying ownership for ${model.modelName} ${id}`);

    const doc = await model.findById(id);

    if (!doc) {
      console.log('❌ Document not found in DB for ID:', id);
      return res.status(404).json({ error: 'Document not found' });
    }

    // Admins skip ownership
    if (req.user.isAdmin) {
      console.log('✅ Admin access granted');
      return next();
    }

    // Ownership check
    if (!doc.user || doc.user.toString() !== req.user.id) {
      console.log('❌ Ownership mismatch', {
        documentOwner: doc.user,
        requestingUser: req.user.id
      });
      return res.status(403).json({ 
        error: 'Access denied',
        details: {
          documentOwner: doc.user,
          requestingUser: req.user.id
        }
      });
    }

    console.log('✅ Ownership verified successfully');
    next();
  } catch (error) {
    console.error('Ownership verification error:', error);
    res.status(500).json({ 
      error: 'Server error',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};
/* report generation */



const logoPath = path.join(__dirname, 'assets', 'SMlogo.png');

async function generateAssessmentReport(sessionId, userId) {
  try {
    await waitForScores(sessionId);

    const [session, testResult, voiceAnswers] = await Promise.all([
      AssessmentSession.findById(sessionId)
        .populate('resumeId')
        .populate('jobDescriptionId')
        .populate('user'),
      TestResult.findOne({ assessmentSession: sessionId }),
      VoiceAnswer.find({ assessmentSession: sessionId }),
    ]);

    if (!session || !testResult) throw new Error('Assessment data not found');

    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const buffers = [];
    doc.on('data', buffers.push.bind(buffers));

    const drawPageBackground = () => {
      const width = doc.page.width;
      const height = doc.page.height;

      const gradient = doc.linearGradient(0, 0, width, 0);
      gradient.stop(0, '#10b981').stop(1, '#3b82f6');
      doc.rect(0, 0, width, height).fill(gradient);

      doc.fillColor('white').roundedRect(40, 40, width - 80, height - 80, 10).fill();

      if (fs.existsSync(logoPath)) {
        doc.image(logoPath, width - 90, 50, { width: 40 });
      }
    };

    const drawSectionBox = (height = 300) => {
      const width = doc.page.width;
      const y = doc.y + 10;
      doc.fillColor('white').roundedRect(60, y, width - 120, height, 8).fill();
      doc.moveDown(1);
      return y;
    };

    drawPageBackground();
    doc.on('pageAdded', drawPageBackground);

    // Title
    doc.fontSize(24).fillColor('#0f172a').font('Helvetica-Bold')
      .text('SkillMatrix AI Assessment Report', 0, 100, { align: 'center' });

    // Candidate Info
    doc.moveDown(2);
    doc.fillColor('#1e293b').fontSize(14).text('Candidate Information', 60, doc.y, { underline: true });
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(12).fillColor('#334155')
      .text(`Email: ${session.candidateEmail}`, 60)
      .text(`Position: ${session.jobTitle}`, 60)
      .text(`Assessment Date: ${session.completedAt.toLocaleDateString()}`, 60);

    // Performance Summary
 doc.addPage();
const chartY = drawSectionBox(400); // increased height
doc.fillColor('#1e293b').fontSize(14)
  .text('Performance Summary', 70, chartY + 10, { underline: true });

const chartBuffer = await createScoreChart({
  mcq: testResult.score,
  audio: testResult.audioScore,
  text: testResult.textScore,
  video: testResult.videoScore,
  combined: testResult.combinedScore,
});

doc.image(chartBuffer, 110, chartY + 40, { fit: [400, 250] }); // moved down to avoid overlap

    doc.fontSize(12).fillColor('#475569')
      .text(`MCQ Score: ${testResult.score.toFixed(2)}/100`, 60, chartY + 280)
      .text(`Audio Score: ${testResult.audioScore.toFixed(2)}/100`, 60)
      .text(`Text Score: ${testResult.textScore?.toFixed(2) || 'N/A'}/100`, 60)
      .text(`Video Score: ${testResult.videoScore.toFixed(2)}/100`, 60)
      .text(`Combined Score: ${testResult.combinedScore.toFixed(2)}/100`, 60);

    // MCQ Section
 doc.addPage();
const headingY = drawSectionBox(60);
doc.fillColor('#1e293b').fontSize(14)
  .text('MCQ Assessment Details', 70, headingY + 15, { underline: true });
doc.moveDown(1);


    session.questions.forEach((q, i) => {
      if (doc.y > 680) doc.addPage();
      const y = drawSectionBox(100);
      doc.fontSize(12).fillColor('#334155').font('Helvetica-Bold')
        .text(`Q${i + 1}: ${q.question}`, 80, y + 15);
      doc.font('Helvetica').fontSize(10).fillColor('#64748b')
        .text(`Candidate Answer: ${q.userAnswer || 'Not answered'}`, 100)
        .text(`Correct Answer: ${q.correctAnswer}`, 100);
      doc.moveDown(2);
    });

    // Voice Section
doc.addPage();
const voiceY = drawSectionBox(); // Use default height or specify
doc.fillColor('#1e293b').fontSize(14)
  .text('Voice Assessment', 70, voiceY + 15, { underline: true });
doc.moveDown(1);



    voiceAnswers.forEach((answer, i) => {
      if (doc.y > 600) doc.addPage();
      const audioScore = answer.audioAnalysis?.grading?.['Total Score'] ?? 0;
      const textScore = answer.textEvaluation?.metrics?.total_average ?? 0;
      const metrics = answer.textEvaluation?.metrics || {};

      const boxHeight = 160 + (Object.keys(metrics).length * 12);
      const y = drawSectionBox(boxHeight);
const boxStartX = 80;

doc.fontSize(12).fillColor('#334155').font('Helvetica-Bold')
  .text(`Q${i + 1}: ${answer.question}`, boxStartX, y + 15, {
    width: doc.page.width - 160,
    lineBreak: true,
  });

doc.fontSize(10).font('Helvetica').fillColor('#64748b')
  .text(`Answer: ${answer.answer || 'No answer provided'}`, boxStartX + 20, doc.y, {
    width: doc.page.width - 160,
    lineBreak: true,
  })
  .text(`Audio Score: ${Number(audioScore).toFixed(2)}/100`, boxStartX + 20)
  .text(`Text Evaluation Score: ${Number(textScore).toFixed(2)}/100`, boxStartX + 20);

if (metrics) {
  doc.moveDown(0.2);
  doc.font('Helvetica-Bold').text('Detailed Text Metrics:', boxStartX + 20, doc.y);
  doc.font('Helvetica');
  Object.entries(metrics).forEach(([key, value]) => {
    if (!['total_average', 'total_overall_score'].includes(key)) {
      const val = typeof value === 'number' ? value.toFixed(2) : value;
      doc.text(`• ${key}: ${val}`, boxStartX + 40, doc.y);
    }
  });
}


      doc.moveDown(2);
    });

    return new Promise((resolve, reject) => {
      doc.on('end', async () => {
        try {
          const pdfBuffer = Buffer.concat(buffers);
          const filename = `report_${sessionId}_${Date.now()}.pdf`;
          const s3Key = `reports/${filename}`;
          await uploadToS3(pdfBuffer, s3Key, 'application/pdf');
          const report = new Report({ assessmentSession: sessionId, s3Key, filename, user: userId });
          await report.save();
          await sendReportToHR(sessionId, userId, s3Key);
          resolve({ s3Key, filename, reportId: report._id });
        } catch (err) {
          reject(err);
        }
      });
      doc.end();
    });

  } catch (error) {
    console.error('Report generation failed:', error);
    throw error;
  }
}




async function createScoreChart(scores) {
  const canvas = createCanvas(700, 400);
  const ctx = canvas.getContext('2d');
  const keys = Object.keys(scores);
  const values = Object.values(scores).map(val => Number(val.toFixed(2)));

  const barWidth = 60;
  const gap = 30;
  const startX = 50;
  const baseY = 350;

  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
ctx.font = 'bold 13px "DejaVu Sans"';


  keys.forEach((key, i) => {
    const x = startX + i * (barWidth + gap);
    const height = (values[i] / 100) * 250;

    ctx.fillStyle = '#3b82f6';
    ctx.fillRect(x, baseY - height, barWidth, height);

    ctx.fillStyle = '#1e293b';
    ctx.fillText(`${values[i]}`, x + 5, baseY - height - 10);
    ctx.fillText(key, x + 5, baseY + 20);
  });

  return canvas.toBuffer();
}


async function waitForScores(sessionId) {
  const maxAttempts = 30;
  let attempts = 0;
  
  while (attempts < maxAttempts) {
    const [testResult, recording, voiceAnswers] = await Promise.all([
      TestResult.findOne({ assessmentSession: sessionId }),
      Recording.findOne({ assessmentSession: sessionId }),
      VoiceAnswer.find({ assessmentSession: sessionId })
    ]);

    // Enhanced check for text evaluation completion
    const scoresReady = testResult && 
      testResult.audioScore !== undefined && 
      testResult.textScore !== undefined && // Ensure textScore is checked
      testResult.videoScore !== undefined && 
      testResult.combinedScore !== undefined;

    const processingComplete = 
      (!recording || recording.videoAnalysis?.status === 'completed') &&
      voiceAnswers.every(a => 
        (a.processingStatus === 'completed' || 
         a.processingStatus === 'failed' ||
         a.processingStatus === 'skipped') &&
        (a.textEvaluation?.status === 'completed' ||
         a.textEvaluation?.status === 'failed' ||
         a.textEvaluation?.status === 'skipped')
      );

    if (scoresReady && processingComplete) {
      return;
    }
    
    attempts++;
  await new Promise(resolve => setTimeout(resolve, 2 * 60 * 1000)); // 5 minutes

  }
  
  throw new Error('Timeout waiting for scores to be calculated');
}

async function sendReportEmail(userEmail, reportUrl, candidateEmail, jobTitle) {
  const mailOptions = {
    from: `"SkillMatrix Reports" <${process.env.EMAIL_USER}>`,
    to: userEmail,
    subject: `Assessment Report for ${candidateEmail} - ${jobTitle}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2563eb;">Assessment Report Ready</h2>
        <p>The assessment report for candidate <strong>${candidateEmail}</strong> is now available.</p>
        <p>Position: <strong>${jobTitle}</strong></p>
        
        <div style="text-align: center; margin: 20px 0;">
          <a href="${reportUrl}" 
             style="background-color: #2563eb; color: white; padding: 10px 20px; 
                    text-decoration: none; border-radius: 5px; display: inline-block;">
            Download Full Report
          </a>
        </div>
        
        <p style="color: #6b7280; font-size: 12px;">
          This report contains confidential assessment data. Please handle appropriately.
        </p>
      </div>
    `
  };

  await transporter.sendMail(mailOptions);
}
/*end points */


app.get('/api/resumes/:resumeId', authenticateJWT, verifyOwnership(Resume), async (req, res) => {
  try {
    const { resumeId } = req.params;
    
    // More thorough validation
    if (!mongoose.Types.ObjectId.isValid(resumeId)) {
      return res.status(400).json({ error: 'Invalid resume ID format' });
    }

    const resume = await Resume.findById(resumeId);
    if (!resume) {
      return res.status(404).json({ error: 'Resume not found' });
    }

    if (!resume.s3Key) {
      return res.status(404).json({ error: 'Resume file not found in storage' });
    }

    const command = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: resume.s3Key,
      ResponseContentDisposition: req.query.download 
        ? `attachment; filename="${encodeURIComponent(resume.filename)}"` 
        : 'inline'
    });
    
    const url = await getSignedUrl(s3, command); // 1 hour expiration
    
    res.json({ 
      success: true,
      url,
      filename: resume.filename,
     
    });

  } catch (error) {
    console.error('Error retrieving resume:', error);
    
    let errorMessage = 'Failed to retrieve resume';
    if (error.name === 'NoSuchKey') {
      errorMessage = 'Resume file not found in storage';
    } else if (error.name === 'AccessDenied') {
      errorMessage = 'Access to resume denied';
    }
    
    res.status(500).json({ 
      success: false,
      error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});
// Add this endpoint right after your JobDescription endpoint
app.get('/api/job-descriptions/:jobDescriptionId', authenticateJWT, verifyOwnership(JobDescription), async (req, res) => {

  try {
    const { jobDescriptionId } = req.params;
    const jobDescription = await JobDescription.findById(jobDescriptionId);
    
    if (!jobDescription) {
      return res.status(404).json({ error: 'Job description not found.' });
    }
    const command = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: jobDescription.s3Key,
      ResponseContentDisposition: req.query.download 
      ? `attachment; filename="${jobDescription.filename}"` 
      : undefined
    });
    
    const url = await getSignedUrl(s3, command); // 5 minutes
    res.status(200).json({ url });
  } catch (error) {
    console.error('Error retrieving job description:', error.message);
    res.status(500).json({ error: 'Failed to retrieve job description.' });
  }
});

// Add these endpoints after your existing JD routes

// Get all JDs for current user
app.get('/api/job-descriptions', authenticateJWT, async (req, res) => {
  try {
    const jds = await JobDescription.find({ user: req.user.id })
      .sort({ uploadedAt: -1 })
      .select('title filename uploadedAt');
    
    res.status(200).json(jds);
  } catch (error) {
    console.error('Error fetching job descriptions:', error);
    res.status(500).json({ error: 'Failed to fetch job descriptions' });
  }
});

// Get JD content by ID
app.get('/api/job-descriptions/:id/content', authenticateJWT, verifyOwnership(JobDescription), async (req, res) => {
  try {
    const jd = await JobDescription.findById(req.params.id);
    if (!jd) {
      return res.status(404).json({ error: 'Job description not found' });
    }

    const command = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: jd.s3Key
    });

    const url = await getSignedUrl(s3, command);
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    
    res.status(200).send(response.data);
  } catch (error) {
    console.error('Error fetching JD content:', error);
    res.status(500).json({ error: 'Failed to fetch JD content' });
  }
});

// Update JD title
app.put('/api/job-descriptions/:id/title', authenticateJWT, verifyOwnership(JobDescription), async (req, res) => {
  try {
    const { title } = req.body;
    if (!title || typeof title !== 'string') {
      return res.status(400).json({ error: 'Valid title is required' });
    }

    const updatedJd = await JobDescription.findByIdAndUpdate(
      req.params.id,
      { title },
      { new: true }
    );

    res.status(200).json(updatedJd);
  } catch (error) {
    console.error('Error updating JD title:', error);
    res.status(500).json({ error: 'Failed to update JD title' });
  }
});

// Delete JD
app.delete('/api/job-descriptions/:id', authenticateJWT, verifyOwnership(JobDescription), async (req, res) => {
  try {
    await JobDescription.findByIdAndDelete(req.params.id);
    // Note: You may want to also delete from S3 in production
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error deleting JD:', error);
    res.status(500).json({ error: 'Failed to delete JD' });
  }
});

app.get('/api/candidate-filtering', authenticateJWT, async (req, res) => {
  try {
    // Step 1: Fetch base candidate responses
     const responses = await ApiResponse.find({ user: req.user.id })
      .populate('resumeId', 'title filename')
      .populate('jobDescriptionId', 'title filename')
      .sort({ createdAt: -1 });

    // Step 2: Fetch related test scores and assessment sessions
    const testScores = await TestResult.find();
    const sessions = await AssessmentSession.find()
      .populate('recording')
      .populate('testResult');

    // Step 3: Enrich responses by matching candidate email
    const enrichedResponses = responses.map(candidate => {
      const email = candidate.matchingResult?.[0]?.["Resume Data"]?.email;

      const testScore = testScores.find(ts => ts.candidateEmail === email);
      const session = sessions.find(s => s.candidateEmail === email);

      return {
        ...candidate.toObject(),
        testScore: testScore || null,
        assessmentSession: session || null
      };
    });

    res.status(200).json(enrichedResponses);
  } catch (error) {
    console.error('Error fetching candidate filtering data:', error.message);
    res.status(500).json({ error: 'Failed to fetch candidate filtering data.' });
  }
});

// Add this new endpoint while keeping all existing endpoints
app.get('/api/candidates/segmented', authenticateJWT, async (req, res) => {
  try {
  const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago'

    
    // First get all needed data (same as original endpoint)
    const [responses, testScores, sessions] = await Promise.all([
       ApiResponse.find({ user: req.user.id })
        .populate('resumeId', 'title filename')
        .populate('jobDescriptionId', 'title filename')
        .sort({ createdAt: -1 }),
      TestResult.find({ user: req.user.id }),
      AssessmentSession.find({ user: req.user.id })
        .populate('recording')
        .populate('testResult')
    ]);

    // Enrich all candidates (same as original)
    const allCandidates = responses.map(candidate => {
      const email = candidate.matchingResult?.[0]?.["Resume Data"]?.email;
      const testScore = testScores.find(ts => ts.candidateEmail === email);
      const session = sessions.find(s => s.candidateEmail === email);

      return {
        ...candidate.toObject(),
        testScore: testScore || null,
        assessmentSession: session || null
      };
    });

    // Now split into recent/history
    const recent = allCandidates.filter(c => 
      new Date(c.createdAt) >= cutoffTime
    );
    const history = allCandidates.filter(c => 
      new Date(c.createdAt) < cutoffTime
    );

    res.status(200).json({
      recent,
      history
    });
  } catch (error) {
    console.error('Error fetching segmented candidates:', error.message);
    res.status(500).json({ error: 'Failed to fetch segmented candidates.' });
  }
});
app.get('/api/consent/:apiResponseId', async (req, res) => {
  const { apiResponseId } = req.params;
  const { allow } = req.query;

  try {
    if (allow !== 'true') {
      return res.status(400).send('❌ Invalid or missing consent flag.');
    }

    const updated = await ApiResponse.findByIdAndUpdate(
      apiResponseId,
      { candidateConsent: { allowedToShare: true, createdAt: new Date() } },
      { new: true }
    );

    if (!updated) return res.status(404).send('❌ Consent not found');

  res.send(`
  <html>
    <head>
      <title>Consent Submitted</title>
      <style>
        body {
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          background: linear-gradient(135deg, #4f46e5, #6ee7b7);
          color: white;
          height: 100vh;
          margin: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-direction: column;
          animation: fadeIn 1s ease-in;
        }

        .card {
          background: rgba(255, 255, 255, 0.1);
          border-radius: 16px;
          padding: 30px 40px;
          box-shadow: 0 8px 20px rgba(0,0,0,0.25);
          text-align: center;
          backdrop-filter: blur(10px);
          max-width: 500px;
        }

        h2 {
          font-size: 2.2rem;
          margin-bottom: 15px;
        }

        p {
          font-size: 1.2rem;
          margin-bottom: 10px;
        }

        .tick {
          font-size: 4rem;
          margin-bottom: 10px;
          animation: bounce 0.8s ease-out;
        }

        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(-10px); }
          to { opacity: 1; transform: translateY(0); }
        }

        @keyframes bounce {
          0%   { transform: scale(0.8); }
          50%  { transform: scale(1.2); }
          100% { transform: scale(1); }
        }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="tick">✅</div>
        <h2>Consent Submitted</h2>
        <p>Thank you for your response.</p>
        <p>Your profile will now be visible to recruiters who are actively hiring.</p>
      </div>
    </body>
  </html>
`);

  } catch (error) {
    console.error('Consent update failed:', error.message);
    res.status(500).send('❌ Internal error');
  }
});

// ✅ FILE: server.js (or routes file)
app.get('/api/recommendations/candidates', authenticateJWT, async (req, res) => {
  try {
    // ✅ Final logic — fetch all candidates who gave consent
    const query = {
      'candidateConsent.allowedToShare': true
    };

    const sharedResponses = await ApiResponse.find(query)
      .populate('resumeId', 'title filename')
      .populate('jobDescriptionId', 'title filename')
      .sort({ createdAt: -1 });

    const testScores = await TestResult.find();
    const sessions = await AssessmentSession.find()
      .populate('recording')
      .populate('testResult');

    const enriched = sharedResponses.map(candidate => {
      const email = candidate.matchingResult?.[0]?.["Resume Data"]?.email;
      const testScore = testScores.find(ts => ts.candidateEmail === email);
      const session = sessions.find(s => s.candidateEmail === email);

      return {
        ...candidate.toObject(),
        testScore: testScore || null,
        assessmentSession: session || null
      };
    });

    res.status(200).json(enriched);
  } catch (error) {
    console.error('Error fetching recommended candidates:', error);
    res.status(500).json({ error: 'Failed to fetch recommended candidates.' });
  }
});




// WebSocket connection handler
io.on('connection', (socket) => {
  console.log('WebSocket client connected.');
  socket.on('disconnect', () => {
    console.log('WebSocket client disconnected.');
  });
});

// Emit event on new ApiResponse creation
const emitApiResponseUpdate = (newResponse) => {
  io.emit('apiResponseUpdated', newResponse);
};
// Add this near the top with other utility functions
const calculateHash = (buffer) => {
  return crypto.createHash('sha256').update(buffer).digest('hex');
};


/* relared to the subscription */
// Subscription check middleware
// Updated checkSubscription middleware
// Enhanced checkSubscription middleware
const checkSubscription = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    
    // Admins bypass all checks
    if (user.isAdmin) return next();

    // Check if subscription exists and is active
    if (!user.subscription || !user.subscription.isActive) {
      return res.status(403).json({ 
        message: 'Subscription inactive. Please contact admin.' 
      });
    }

    // Check if subscription expired
    if (user.subscription.expiresAt && new Date() > user.subscription.expiresAt) {
      // Automatically downgrade to trial if paid subscription expires
      if (user.subscription.plan === 'paid') {
        await downgradeToTrial(user._id);
      }
      return res.status(403).json({ 
        message: 'Subscription expired. Please renew your plan.' 
      });
    }

    next();
  } catch (error) {
    console.error('Subscription check error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Helper function to downgrade to trial
async function downgradeToTrial(userId) {
  const now = new Date();
  await User.findByIdAndUpdate(userId, {
    $unset: {
      isUnlimited: ""
    },
    subscription: {
      plan: 'trial',
      startedAt: now,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000), // 1 day
      isActive: true,
      limits: {
        jdUploads: 1,
        resumeUploads: 5,
        assessments: 1
      }
    },
    trialStart: now,
    trialEnd: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    usage: {
      jdUploads: 0,
      resumeUploads: 0,
      assessments: 0
    }
  });
}
// Updated usage limit middleware

// Enhanced checkUsageLimits middleware
// Enhanced checkUsageLimits middleware
const checkUsageLimits = (type) => async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    
    // Skip all checks for admin
    if (user.isAdmin) return next();

    // Skip checks for paid users without limits
    if (user.subscription.plan === 'paid' && !user.subscription.limits) {
      return next();
    }

    // Check if subscription exists and is active
    if (!user.subscription || !user.subscription.isActive) {
      return res.status(403).json({ 
        message: 'Subscription inactive. Please contact admin.' 
      });
    }

    // Check if expired
    if (user.subscription.expiresAt && new Date() > user.subscription.expiresAt) {
      return res.status(403).json({ 
        message: 'Subscription expired. Please renew your plan.' 
      });
    }

    // Check usage against limits
    if (user.subscription.limits && user.usage[type] >= user.subscription.limits[type]) {
      return res.status(403).json({ 
        message: `You've reached your ${type} limit for your current plan.` 
      });
    }

    next();
  } catch (error) {
    console.error('Usage limit check error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Helper function for trial limits
const getTrialLimit = (type) => {
  const trialLimits = {
    jdUploads: 1,
    resumeUploads: 10,
    assessments: 1
  };
  return trialLimits[type] || 0;
};

// POST Endpoint: Upload Resumes and Job Descriptions
app.post('/api/submit',authenticateJWT,checkSubscription,checkUsageLimits('jdUploads'),checkUsageLimits('resumeUploads'), upload.fields([{ name: 'resumes' }, { name: 'job_description' }]), async (req, res) => {
  let duplicateCount = 0;
  try {
    const { files } = req;

    if (!files || !files.resumes || !files.job_description) {
      return res.status(400).json({ error: 'Resumes and job descriptions are required.' });
    }

    const results = [];

    // Process job descriptions
    for (const jobDescription of files.job_description) {
      const jdHash = calculateHash(jobDescription.buffer);

      let jobDescDoc = await JobDescription.findOne({ hash: jdHash });
      if (!jobDescDoc) {
        // Upload to S3
        const jdS3Params = {
          Bucket: process.env.S3_BUCKET_NAME,
          Key: `job_descriptions/${Date.now()}_${jobDescription.originalname}`,
          Body: jobDescription.buffer,
          ContentType: 'application/pdf'
        };
        await s3.send(new PutObjectCommand(jdS3Params));
        
        jobDescDoc = new JobDescription({
          title: jobDescription.originalname,
          s3Key: jdS3Params.Key, // Store the S3 key
          filename: jobDescription.originalname,
          hash: jdHash,
          user: req.user.id
        });
        await jobDescDoc.save();
      }

      // Process resumes
      for (const resume of files.resumes) {
        const resumeHash = calculateHash(resume.buffer);

        let resumeDoc = await Resume.findOne({ hash: resumeHash });
        if (!resumeDoc) {
          // Upload to S3
          const resumeS3Params = {
            Bucket: process.env.S3_BUCKET_NAME,
            Key: `resumes/${Date.now()}_${resume.originalname}`,
            Body: resume.buffer,
            ContentType: 'application/pdf'
          };
          await s3.send(new PutObjectCommand(resumeS3Params));
          
          resumeDoc = new Resume({
            title: resume.originalname,
            s3Key: resumeS3Params.Key, // Store the S3 key
            filename: resume.originalname,
            hash: resumeHash,
              user: req.user.id
          });
          await resumeDoc.save();
        }

        const existingResponse = await ApiResponse.findOne({ hash: `${resumeHash}-${jdHash}` });
        if (existingResponse) {
          console.log(`Duplicate found for Resume: ${resume.originalname} and Job Description: ${jobDescription.originalname}. Skipping.`);
          duplicateCount++; // Increment duplicate counter
          continue;
        }

        const formData = new FormData();
        formData.append('resumes', resume.buffer, resume.originalname);
        formData.append('job_description', jobDescription.buffer, jobDescription.originalname);

        try {
          const apiResponse = await axios.post(
            process.env.RESUME_JD_MATCHING,
            formData,
            { headers: formData.getHeaders() }
          );

          if (apiResponse.data && apiResponse.data['POST Response']) {
            const savedResponse = new ApiResponse({
  resumeId: resumeDoc._id,
  jobDescriptionId: jobDescDoc._id,
  matchingResult: apiResponse.data['POST Response'],
  hash: `${resumeHash}-${jdHash}`,
  user: req.user.id
});
await savedResponse.save();  // <-- Candidate consent is default false

// ✅ SEND CANDIDATE EMAIL HERE (with link to give consent)
const extractedEmail = apiResponse.data['POST Response']?.[0]?.["Resume Data"]?.email;

if (extractedEmail) {
  await sendConsentEmail(extractedEmail, savedResponse._id);
  console.log(`📨 Sending consent email to: ${extractedEmail}`);

} else {
  console.warn(`⚠️ No email found in API response for ${resume.originalname}`);
}


emitApiResponseUpdate(savedResponse);


            results.push({
              resumeId: resumeDoc._id,
              jobDescriptionId: jobDescDoc._id,
              matchingResult: apiResponse.data['POST Response'],
            });
          }
        } catch (error) {
          console.error(`Error with external API for ${resume.originalname}:`, error.message);
        }
      }
    }
// Update usage
      await User.findByIdAndUpdate(req.user.id, {
        $inc: {
          'usage.jdUploads': files.job_description.length,
          'usage.resumeUploads': files.resumes.length
        }
      });
    console.log(`Total duplicates found: ${duplicateCount}`); // Log the total number of duplicates
    res.status(200).json({ message: 'Files processed and stored successfully.', results, duplicateCount });
  } catch (error) {
    console.error('Upload Error:', {
      message: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
    res.status(500).json({ 
      error: 'File processing failed',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

                                /*
                                  This is related to the test platfrom
                                */

// Add this to your startup checks:
function ensureCleanTempDir() {
  const tempDir = os.tmpdir();
  fs.readdirSync(tempDir).forEach(file => {
    if (file.startsWith('whisper_')) {
      try {
        fs.rmSync(path.join(tempDir, file), { recursive: true, force: true });
      } catch (e) {
        console.error('Failed to clean temp file:', file, e);
      }
    }
  });
}

const evaluateTextResponse = async (question, answer) => {
  try {
    const response = await axios.post(process.env.TEXT_EVALUATION_API_URL, {
      question,
      answer
    });
    
    return response.data;
  } catch (error) {
    console.error('Text evaluation failed:', error);
    throw error;
  }
};


async function calculateAndStoreScores(sessionId) {
  try {
    const [answers, recording, testResult] = await Promise.all([
      VoiceAnswer.find({ assessmentSession: sessionId }),
      Recording.findOne({ assessmentSession: sessionId }),
      TestResult.findOne({ assessmentSession: sessionId })
    ]);

    // Get all questions (including skipped ones)
    const session = await AssessmentSession.findById(sessionId);
    const totalQuestions = session.voiceQuestions.length;

     // Filter out skipped/invalid answers
    const validAnswers = answers.filter(a => a.valid && 
      a.processingStatus === 'completed' && 
      a.audioAnalysis?.status === 'completed');
    
    // Audio scores (0 for invalid/skipped)
    const audioScores = session.voiceQuestions.map(q => {
      const answer = answers.find(a => a.questionId === q.id);
      return answer?.audioAnalysis?.grading?.['Total Score'] || 0;
    });

    // Text scores (0 for invalid/skipped)
    const textScores = session.voiceQuestions.map(q => {
      const answer = answers.find(a => a.questionId === q.id);
      return answer?.textEvaluation?.metrics?.total_average || 0;
    });

    // Calculate averages (include 0 for skipped questions)
    const audioAverage = audioScores.reduce((a, b) => a + b, 0) / totalQuestions;
    const textAverage = textScores.reduce((a, b) => a + b, 0) / totalQuestions;
    const videoScore = recording?.videoAnalysis?.video_score || 0;
    const mcqScore = testResult.score || 0;

    // Final combined score calculation (same weights as before)
    const voiceComponent = (audioAverage * 0.1) + (textAverage * 0.8) + (videoScore * 0.1);
    const combinedScore = Math.round((mcqScore * 0.4) + (voiceComponent * 0.6));

    // Update TestResult
    await TestResult.findOneAndUpdate(
      { assessmentSession: sessionId },
      { 
        audioScore: audioAverage,
        textScore: textAverage,
        videoScore,
        combinedScore,
        questionsAttempted: validAnswers.length,
        totalQuestions
      },
      { new: true }
    );

    return combinedScore;
  } catch (error) {
    console.error('Error calculating scores:', error);
    return null;
  }
}




// Update the analyzeAudio function to handle WAV files
const analyzeAudio = async (s3Keys) => {
  try {
    const form = new FormData();
    
    for (const key of s3Keys) {
      const { stream } = await getS3ReadStream(key);
      form.append('audios', stream, {
        filename: path.basename(key),
        contentType: 'audio/wav'
      });
    }

    const response = await axios.post(process.env.AUDIO_EVALUATION_API_URL, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    return response.data;
  } catch (error) {
    console.error('Audio analysis failed:', error);
    throw error;
  }
};



async function calculateAndStoreAudioScore(sessionId) {
  try {
    // Get all completed voice answers for this session
    const answers = await VoiceAnswer.find({
      assessmentSession: sessionId,
      'audioAnalysis.status': 'completed',
      'audioAnalysis.grading.Total Score': { $exists: true }
    });

    if (answers.length === 0) return null;

    // Include ALL answers in calculation, even those with zero scores
    const audioScores = answers.map(a => a.audioAnalysis.grading['Total Score'] || 0);
    const average = audioScores.reduce((sum, score) => sum + score, 0) / answers.length;

    // Update TestResult
    await TestResult.findOneAndUpdate(
      { assessmentSession: sessionId },
      { audioScore: average },
      { new: true }
    );

    return average;
  } catch (error) {
    console.error('Error calculating audio score:', error);
    return null;
  }
}
// Add this to server.js initialization
async function checkPendingScores() {
  try {
    const sessions = await AssessmentSession.find({
      status: 'completed',
      $or: [
        { 'testResult.audioScore': { $exists: false } },
        { 'testResult.videoScore': { $exists: false } },
        { 'testResult.combinedScore': { $exists: false }}
      ]
    }).populate('voiceAnswers');

    for (const session of sessions) {
      if (session.voiceAnswers?.some(a => a.audioAnalysis?.status === 'completed')) {
        await calculateAndStoreAudioScore(session._id);
      }
      
      // Check for video score
      await calculateAndStoreVideoScore(session._id);
      await calculateAndStoreScores(session._id);
    }
  } catch (error) {
    console.error('Background score check failed:', error);
  }
}
// Enhanced S3 stream handling
async function getS3ReadStream(s3Key) {
  try {
    const command = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: s3Key
    });

    const response = await s3.send(command);
    
    if (!response.Body) {
      throw new Error('No body in S3 response');
    }

    return {
      stream: response.Body,
      contentLength: response.ContentLength,
      contentType: response.ContentType || 'application/octet-stream'
    };
  } catch (error) {
    console.error('Error getting S3 read stream:', error);
    throw error;
  }
}
async function getSignedUrlForS3(key) {
  const command = new GetObjectCommand({
    Bucket: process.env.S3_BUCKET_NAME,
    Key: key
  });
  return getSignedUrl(s3, command); // 1 hour
}
// Enhanced processTranscription with proper temp file handling
// Enhanced audio validation with better silence detection
async function validateAudio(audioBuffer) {
  try {
    const MIN_AUDIO_LENGTH = 2000; // 2 seconds minimum
    const SILENCE_THRESHOLD = 0.01; // More sensitive threshold
    
    // Check buffer size first
    if (!audioBuffer || audioBuffer.length < MIN_AUDIO_LENGTH) {
      return { valid: false, reason: 'Audio too short' };
    }

    // Advanced silence detection using Web Audio API (if available)
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const buffer = await audioContext.decodeAudioData(audioBuffer.buffer.slice(0));
      
      // Calculate RMS (Root Mean Square) for better silence detection
      let sum = 0;
      const channelData = buffer.getChannelData(0);
      const sampleSize = Math.min(channelData.length, 44100); // Check first second
      
      for (let i = 0; i < sampleSize; i++) {
        sum += channelData[i] * channelData[i];
      }
      
      const rms = Math.sqrt(sum / sampleSize);
      
      return { 
        valid: rms > SILENCE_THRESHOLD,
        reason: rms > SILENCE_THRESHOLD ? '' : 'No speech detected (silent audio)'
      };
    } catch (webAudioError) {
      // Fallback to simpler validation if Web Audio API fails
      const view = new DataView(audioBuffer.buffer);
      let sum = 0;
      const sampleSize = Math.min(audioBuffer.length, 44100 * 2); // Check first second (16-bit samples)
      
      for (let i = 0; i < sampleSize; i += 2) {
        const sample = view.getInt16(i, true);
        sum += sample * sample;
      }
      
      const rms = Math.sqrt(sum / (sampleSize / 2)) / 32768;
      return {
        valid: rms > SILENCE_THRESHOLD,
        reason: rms > SILENCE_THRESHOLD ? '' : 'No speech detected (silent audio)'
      };
    }
  } catch (error) {
    return { valid: false, reason: 'Audio validation error' };
  }
}

// Enhanced processTranscription with silent audio handling
async function processTranscription(answerId) {
  try {
    const answer = await VoiceAnswer.findById(answerId);
    if (!answer) {
      throw new Error('Voice answer not found');
    }

    // Skip if answer was marked as skipped or invalid
    if (answer.processingStatus === 'skipped' || !answer.valid) {
      console.log(`Skipping transcription for answer ${answerId}`);
      return;
    }

    // Validate audio path exists
    if (!answer.audioPath) {
      await VoiceAnswer.findByIdAndUpdate(answerId, {
        processingStatus: 'failed',
        skipReason: 'Missing audio file',
        $set: {
          'audioAnalysis.status': 'failed',
          'textEvaluation.status': 'failed'
        }
      });
      return;
    }

    // Get audio stream from S3
    let audioBuffer;
    try {
      const { stream: audioStream } = await getS3ReadStream(answer.audioPath);
      audioBuffer = await streamToBuffer(audioStream);
      
      // Check if audio buffer is empty or too small
      if (!audioBuffer || audioBuffer.length < 1024) {
        throw new Error('Audio file is too small or empty');
      }
    } catch (streamError) {
      await VoiceAnswer.findByIdAndUpdate(answerId, {
        processingStatus: 'failed',
        skipReason: 'Failed to load audio file',
        $set: {
          'audioAnalysis.status': 'failed',
          'textEvaluation.status': 'failed'
        }
      });
      return;
    }

    // Enhanced audio validation
    const validation = await validateAudio(audioBuffer);
    if (!validation.valid) {
      const isSilentAudio = validation.reason.includes('silent');
      
      await VoiceAnswer.findByIdAndUpdate(answerId, {
        processingStatus: isSilentAudio ? 'completed' : 'failed',
        answer: isSilentAudio ? '[SILENT_AUDIO]' : undefined,
        skipReason: validation.reason,
        $set: {
          'audioAnalysis.status': isSilentAudio ? 'completed' : 'failed',
          'textEvaluation.status': isSilentAudio ? 'skipped' : 'failed',
          'textEvaluation.skipReason': isSilentAudio ? 'Silent audio - no speech detected' : undefined
        }
      });
      
      console.log(`Audio validation ${isSilentAudio ? 'completed (silent)' : 'failed'} for answer ${answerId}`);
      return;
    }

    // Create form data for Flask service
    const form = new FormData();
    form.append('audio', audioBuffer, {
      filename: `answer_${answerId}.wav`,
      contentType: 'audio/wav'
    });

    // Call Whisper service with timeout
    let response;
    try {
      response = await axios.post(
        `${process.env.WHISPER_API_URL}/transcribe`, 
        form, 
        {
          headers: form.getHeaders(),

          maxContentLength: Infinity,
          maxBodyLength: Infinity
        }
      );
    } catch (apiError) {
      throw new Error(`Transcription API failed: ${apiError.message}`);
    }

    // Handle empty or invalid response
    if (!response.data || typeof response.data.text !== 'string') {
      throw new Error('Invalid transcription response format');
    }

    const rawText = response.data.text;
    const cleanedText = cleanTranscriptionText(rawText);

    // Handle silent/empty results
    if (!cleanedText || cleanedText.trim().length === 0) {
      await VoiceAnswer.findByIdAndUpdate(answerId, {
        processingStatus: 'completed',
        answer: '[SILENT_AUDIO]',
        transcriptionPath: null,
        $set: {
          'textEvaluation.status': 'skipped',
          'textEvaluation.skipReason': 'Empty transcription result - no speech detected'
        }
      });
      console.log(`Silent audio processed for answer ${answerId}`);
      return;
    }

    // Upload transcription to S3 if we have valid text
    const transcriptionKey = `transcripts/${answerId}.txt`;
    await uploadToS3(Buffer.from(cleanedText), transcriptionKey, 'text/plain');

    // Update database with successful transcription
    const updatedAnswer = await VoiceAnswer.findByIdAndUpdate(
      answerId,
      {
        transcriptionPath: transcriptionKey,
        answer: cleanedText,
        processingStatus: 'completed',
        $set: {
          'audioAnalysis.status': 'completed'
        }
      },
      { new: true }
    );

    console.log(`✅ Transcription completed for answer ${answerId}`);

    // Evaluate text response if we have a question and valid text
    if (updatedAnswer.question && cleanedText && cleanedText !== '[SILENT_AUDIO]') {
      try {
        await VoiceAnswer.findByIdAndUpdate(answerId, {
          'textEvaluation.status': 'processing'
        });

        const evaluation = await evaluateTextResponse(
          updatedAnswer.question, 
          cleanedText
        );
        
        await VoiceAnswer.findByIdAndUpdate(answerId, {
          textEvaluation: {
            metrics: evaluation,
            processedAt: new Date(),
            status: 'completed'
          }
        });

        await calculateAndStoreScores(updatedAnswer.assessmentSession);
      } catch (evalError) {
        console.error('Text evaluation failed:', evalError);
        await VoiceAnswer.findByIdAndUpdate(answerId, {
          'textEvaluation.status': 'failed',
          'textEvaluation.skipReason': evalError.message.substring(0, 200)
        });
      }
    }

  } catch (error) {
    console.error(`Transcription failed for answer ${answerId}:`, error);
    await VoiceAnswer.findByIdAndUpdate(answerId, {
      processingStatus: 'failed',
      skipReason: error.message.substring(0, 200),
      $set: {
        'audioAnalysis.status': 'failed',
        'textEvaluation.status': 'failed'
      }
    });
  }
}

// Enhanced text cleaning function
function cleanTranscriptionText(rawText) {
  if (!rawText) return '';
  
  // Handle Whisper's silent/empty indicators
  const silentIndicators = ['[silence]', '[empty]', '[no speech]', '...'];
  if (silentIndicators.some(indicator => rawText.toLowerCase().includes(indicator))) {
    return '';
  }

  // Split into lines and filter out metadata
  const lines = rawText.split('\n').filter(line => {
    return !line.includes('Detecting language') && 
           !line.includes('Detected language') && 
           line.trim() !== '';
  });

  // Remove timestamps and special characters
  const cleanedLines = lines.map(line => {
    return line
      .replace(/\[\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}\.\d{3}\]/g, '')
      .replace(/\[.*?\]/g, '')
      .replace(/^\s+|\s+$/g, '')
      .replace(/\s+/g, ' ');
  });

  // Join and final clean
  let result = cleanedLines.join(' ').trim();
  
  // Final check for empty content
  if (result === '' || result.length < 2) {
    return '';
  }

  return result;
}



// New helper function for background tasks
async function processBackgroundTasks(recording) {
  try {
    await Recording.findByIdAndUpdate(recording._id, {
      'videoAnalysis.status': 'processing'
    });

    // Get video stream from S3
    const { stream: videoStream } = await getS3ReadStream(recording.videoPath);

    // Create form with stream
    const form = new FormData();
    form.append('video', videoStream, {
      filename: `interview_${recording._id}.webm`,
      contentType: 'video/webm'
    });

    // Process with API
    const response = await axios.post(process.env.VIDEO_EVALUATION_API_URL, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    // Upload results to S3
    const analysisKey = `analysis/${recording._id}_emotions.json`;
    await uploadToS3(
      Buffer.from(JSON.stringify(response.data)),
      analysisKey,
      'application/json'
    );

    // Update recording
    await Recording.findByIdAndUpdate(recording._id, {
      videoAnalysis: {
        emotions: response.data,
        processedAt: new Date(),
        status: 'completed',
        s3Key: analysisKey
      }
    });

    // Calculate scores
    await calculateAndStoreVideoScore(recording.assessmentSession);
    await calculateAndStoreScores(recording.assessmentSession);

  } catch (error) {
    console.error('Background processing error:', error);
    await Recording.findByIdAndUpdate(recording._id, {
      'videoAnalysis.status': 'failed'
    });
  }
}
// Update the interval to use the new function
setInterval(checkPendingScores, 3600000); // Every hour
checkPendingScores(); // Run on startup

// Helper function to analyze video files
async function analyzeVideoFile(file) {
  try {
    const form = new FormData();
    const fileStream = Readable.from(file.buffer);
    
    form.append('video', fileStream, {
      filename: file.originalname,
      contentType: file.mimetype,
      knownLength: file.size
    });

    const response = await axios.post(process.env.VIDEO_EVALUATION_API_URL, form, {
      headers: {
        ...form.getHeaders(),
        'Content-Length': form.getLengthSync()
      },
      maxBodyLength: Infinity,
    });

    if (!response.data?.emotion_results) {
      throw new Error('Invalid API response format - missing emotion_results');
    }

    // Return the parsed data structure
    return {
      emotion_results: response.data.emotion_results,
      video_score: response.data.video_score || 75.0
    };
  } catch (error) {
    console.error('Video analysis failed:', error);
    throw error;
  }
}
async function calculateAndStoreVideoScore(sessionId) {
  try {
    const recording = await Recording.findOne({ 
      assessmentSession: sessionId,
      'videoAnalysis.status': 'completed'
    });

    if (!recording || !recording.videoAnalysis.video_score) {
      console.error('No completed recording or video score found');
      return null;
    }

    const videoScore = recording.videoAnalysis.video_score;

    // Update TestResult with the video score
    await TestResult.findOneAndUpdate(
      { assessmentSession: sessionId },
      { $set: { videoScore } },
      { upsert: true, new: true }
    );

    console.log(`✅ Saved video score: ${videoScore} for session: ${sessionId}`);
    return videoScore;
  } catch (error) {
    console.error('Error calculating video score:', error);
    return null;
  }
}

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});


// Enhanced stream to buffer with timeout
async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setTimeout(() => {
      stream.destroy();
      reject(new Error(`Stream timeout after ${process.env.WHISPER_TIMEOUT || 60000}ms`));
    }, process.env.WISPER_TIMEOUT || 60000);

    stream.on('data', chunk => chunks.push(chunk));
    stream.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    stream.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
  });
}


// ✅ AFTER — UPDATED uploadToS3 for folder structure in single bucket
async function uploadToS3(fileData, key, contentType, bucket = process.env.S3_BUCKET_NAME) {
  try {
    if (!fileData) throw new Error('No file data provided');

    const body = fileData instanceof Buffer ? Readable.from(fileData) : fileData;

    const upload = new Upload({
      client: s3,
      params: {
        Bucket: bucket, // 🔄 Always skillmatrixaws (default)
        Key: key, // 🔄 Example: job_descriptions/JD_filename.pdf
        Body: body,
        ContentType: contentType
      },
      queueSize: 4,
      partSize: 1024 * 1024 * 5,
      leavePartsOnError: false
    });

    upload.on('httpUploadProgress', progress => {
      console.log(`Upload progress: ${progress.loaded}/${progress.total}`);
    });

    const result = await upload.done();
    console.log(`✅ S3 Upload Success: ${key} to bucket ${bucket}`);
    return result;
  } catch (error) {
    console.error('S3 Upload Error:', {
      message: error.message,
      stack: error.stack,
      key,
      contentType,
      timestamp: new Date().toISOString()
    });
    throw error;
  }
}


/* endpoints related to the test evaluation an test platfrom */



// Updated generate-questions endpoint with direct S3 streaming

// Updated generate-questions endpoint with direct S3 streaming
app.post('/api/generate-questions', async (req, res) => {
  try {
    console.log('Request body:', req.body);
    
    const { resumeId, jobDescriptionId } = req.body;
    
    // Validate input
    if (!resumeId || !jobDescriptionId) {
      return res.status(400).json({ 
        success: false,
        error: 'Both resumeId and jobDescriptionId are required' 
      });
    }
    
    if (!mongoose.Types.ObjectId.isValid(resumeId)) {
      return res.status(400).json({ 
        success: false,
        error: 'Invalid resumeId format' 
      });
    }
    
    if (!mongoose.Types.ObjectId.isValid(jobDescriptionId)) {
      return res.status(400).json({ 
        success: false,
        error: 'Invalid jobDescriptionId format' 
      });
    }

    // Fetch file references from database
    const [resume, jd] = await Promise.all([
      Resume.findById(resumeId),
      JobDescription.findById(jobDescriptionId)
    ]);

    if (!resume || !resume.s3Key) {
      return res.status(404).json({ 
        success: false,
        error: 'Resume not found or has no file' 
      });
    }
    if (!jd || !jd.s3Key) {
      return res.status(404).json({ 
        success: false,
        error: 'Job description not found or has no file' 
      });
    }

    // Get readable streams directly from S3
    const [resumeStream, jdStream] = await Promise.all([
      getS3ReadStream(resume.s3Key),
      getS3ReadStream(jd.s3Key)
    ]);

    // Create form data with direct S3 streams
    const form = new FormData();
    form.append('resumes', resumeStream.stream, {
      filename: resume.filename || 'resume.pdf',
      contentType: 'application/pdf',
      knownLength: resumeStream.contentLength
    });
    form.append('job_description', jdStream.stream, {
      filename: jd.filename || 'job_description.pdf',
      contentType: 'application/pdf',
      knownLength: jdStream.contentLength
    });

    console.log('Streaming files directly from S3 to question generation API...');
    
    // Get headers with synchronous length since we have knownLength
    const headers = {
      ...form.getHeaders(),
      'Content-Length': form.getLengthSync()
    };

    // Call question generation API with proper headers
    const response = await axios.post(process.env.MCQ_GENERATION_API, form, {
      headers,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    
    });

    // Parse the API response correctly
    const apiResponse = response.data;
    let questions = [];
    
    // Handle the specific response format we're seeing
    if (apiResponse && apiResponse['POST Response'] && apiResponse['POST Response'][0]) {
      const mcqData = apiResponse['POST Response'][0]['MCQ with answers'];
      if (mcqData && mcqData.questions) {
        questions = mcqData.questions;
      }
    }

    if (questions.length === 0) {
      throw new Error('No valid questions found in API response');
    }

    // Transform questions to match our format
    const formattedQuestions = questions.map((q, index) => ({
      id: `q-${index}-${Date.now()}`,
      question: q.question,
      options: q.options,
      correctAnswer: q.answer
    }));

    res.json({ 
      success: true,
      questions: formattedQuestions,
      resumeTitle: resume.title,
      jdTitle: jd.title,
      generatedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('Question generation failed:', error);
    
    let errorMessage = 'Failed to generate questions';
    if (error.code === 'ECONNABORTED') {
      errorMessage = 'Question generation timed out';
    } else if (error.message.includes('No valid questions')) {
      errorMessage = 'The question API returned an unexpected format';
    } else if (error.response?.data?.message) {
      errorMessage = error.response.data.message;
    }
    
    res.status(500).json({ 
      success: false,
      error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});
app.post('/api/generate-voice-questions', async (req, res) => {
  try {
    const { jobDescriptionId } = req.body;
    
    if (!jobDescriptionId) {
      return res.status(400).json({ 
        success: false,
        error: 'jobDescriptionId is required' 
      });
    }

    const jd = await JobDescription.findById(jobDescriptionId);
    if (!jd || !jd.s3Key) {
      return res.status(404).json({ 
        success: false,
        error: 'Job description not found or has no file' 
      });
    }

  // Get stream directly from S3
  const jdStream = await getS3ReadStream(jd.s3Key);

  const form = new FormData();
  form.append('job_description', jdStream.stream, {
    filename: jd.filename || 'job_description.pdf',
    contentType: jdStream.contentType || 'application/pdf',
    knownLength: jdStream.contentLength
  });

  console.log('Streaming JD directly from S3 to voice question API...');

  const headers = {
    ...form.getHeaders(),
    'Content-Length': form.getLengthSync(),
    'Accept': 'application/json'
  };

  const response = await axios.post(process.env.VOICE_GENERATION_API, form, {
    headers,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

    // Validate API response structure
    if (!response.data || 
        !response.data['POST Response'] || 
        !response.data['POST Response'][0] || 
        !response.data['POST Response'][0]['Questions'] || 
        !response.data['POST Response'][0]['Questions'].questions) {
      throw new Error('Invalid response structure from voice question API');
    }

    const apiQuestions = response.data['POST Response'][0]['Questions'].questions;
    
    if (!Array.isArray(apiQuestions)) {
      throw new Error('Questions should be an array');
    }

    // Transform questions to match our format
    const formattedQuestions = apiQuestions.map((q, index) => ({
      id: `v-${index}-${Date.now()}`,
      question: q.question || `Voice question ${index + 1}`
    }));

    if (formattedQuestions.length === 0) {
      throw new Error('No valid questions generated');
    }

    res.json({ 
      success: true,
      questions: formattedQuestions,
      jdTitle: jd.title,
      generatedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('Voice question generation failed:', error);
    
    let errorMessage = 'Failed to generate voice questions';
    let errorDetails = null;
    
    if (error.response) {
      // The request was made and the server responded with a status code
      console.error('API response error:', error.response.status, error.response.data);
      errorMessage = `Voice question API responded with ${error.response.status}`;
      errorDetails = error.response.data?.message || error.response.data;
    } else if (error.request) {
      // The request was made but no response was received
      console.error('No response received:', error.request);
      errorMessage = 'No response from voice question API';
    } else {
      // Something happened in setting up the request
      console.error('Request setup error:', error.message);
      errorMessage = error.message;
    }
    
    res.status(500).json({ 
      success: false,
      error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? errorDetails : undefined
    });
  }
});


// Test link generator //
// Updated send-test-link endpoint with NodeMailer
app.post('/api/send-test-link', authenticateJWT, checkSubscription, checkUsageLimits('assessments'), async (req, res) => {
  const { candidateEmail, jobTitle, resumeId, jobDescriptionId, questions, voiceQuestions } = req.body;
  
  // Enhanced validation
  if (!questions || !Array.isArray(questions)) {
    return res.status(400).json({ error: 'Questions array is required' });
  }

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(candidateEmail)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  try {
    // Verify resume and JD exist
    const [resume, jd] = await Promise.all([
      Resume.findById(resumeId),
      JobDescription.findById(jobDescriptionId)
    ]);

    if (!resume || !resume.s3Key) {
      return res.status(404).json({ error: 'Resume not found in S3' });
    }
    if (!jd || !jd.s3Key) {
      return res.status(404).json({ error: 'Job description not found in S3' });
    }

    const token = require('crypto').randomBytes(20).toString('hex');
    const testLink = `${process.env.FRONTEND_URL}/assessment/${token}`;

    // Create session
    const session = new AssessmentSession({
      user: req.user.id,
      candidateEmail,
      jobTitle,
      testLink,
      status: 'pending',
      questions,
      voiceQuestions,
      resumeId,
      jobDescriptionId
    });
    await session.save();

     // Increment assessment count
    await User.findByIdAndUpdate(req.user.id, {
      $inc: { 'usage.assessments': 1 }
    });


  

    // Email options
    const mailOptions = {
      from: `"Assessment System" <${process.env.EMAIL_USER}>`,
      to: candidateEmail,
      subject: `Your Assessment for ${jobTitle}`,
      text: `Please complete your assessment at: ${testLink}`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background-color: #f8f9fa; padding: 20px; text-align: center; }
            .content { padding: 20px; }
            .button { 
              display: inline-block; 
              padding: 10px 20px; 
              background-color: #007bff; 
              color: white !important; 
              text-decoration: none; 
              border-radius: 5px; 
              margin: 20px 0;
            }
            .footer { margin-top: 20px; font-size: 12px; color: #6c757d; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h2>Assessment Invitation</h2>
            </div>
            <div class="content">
              <p>Hello,</p>
              <p>You've been invited to complete an assessment for the position of <strong>${jobTitle}</strong>.</p>
              
              <a href="${testLink}" class="button">Start Assessment</a>
              
              <p>Or copy and paste this link into your browser:</p>
              <p><code>${testLink}</code></p>
              
              <p><strong>Note:</strong> This assessment includes:</p>
              <ul>
                <li>System verification</li>
                <li>Video interview recording</li>
                <li>MCQ test</li>
              </ul>
              <p>Your screen and camera will be recorded during the assessment.</p>
              
              <p>This link will expire in 24 hours.</p>
            </div>
            <div class="footer">
              <p>If you didn't request this assessment, please ignore this email.</p>
            </div>
          </div>
        </body>
        </html>
      `
    };

    // Send email with detailed error handling
    try {
      await transporter.sendMail(mailOptions);
      console.log(`Email sent to ${candidateEmail}`);
      
      res.status(200).json({ 
        success: true,
        message: 'Assessment link sent successfully!', 
        sessionId: session._id,
        testLink // Return the link for debugging
      });
    } catch (emailError) {
      console.error('Email sending failed:', emailError);
      
      // Delete the session if email fails
      await AssessmentSession.findByIdAndDelete(session._id);
        await User.findByIdAndUpdate(req.user.id, {
        $inc: { 'usage.assessments': 1 }
      });
      // Extract detailed error message
      let errorMessage = 'Failed to send assessment email';
      if (emailError.response) {
        errorMessage = emailError.response;
      }
      
      res.status(500).json({ 
        success: false,
        error: errorMessage,
        details: process.env.NODE_ENV === 'development' ? emailError : undefined
      });
    }
  } catch (error) {
    console.error('Error in send-test-link:', error);
    res.status(500).json({ 
      error: 'Failed to create assessment session',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});


// New endpoint to start assessment recording
app.post('/api/start-assessment-recording', async (req, res) => {
  const { token } = req.body;
  
  try {
    const session = await AssessmentSession.findOneAndUpdate(
      { testLink: `${process.env.FRONTEND_URL}/assessment/${token}` },
      { status: 'in-progress', startedAt: new Date() },
      { new: true }
    );
    
    if (!session) {
      return res.status(404).json({ error: 'Assessment session not found.' });
    }
    
    res.status(200).json(session);
  } catch (error) {
    console.error('Error starting assessment:', error);
    res.status(500).json({ error: 'Failed to start assessment.' });
  }
});


// Updated complete-assessment endpoint
// Enhanced complete-assessment endpoint
app.post('/api/complete-assessment', async (req, res) => {
  const { token, score, recordingId, answers } = req.body;
  // Validate input
  if (!token || score === undefined) {
    return res.status(400).json({ 
      error: 'Token and score are required',
      code: 'INVALID_INPUT'
    });
  }

  try {
    // 1. Find and validate session with transaction
    const session = await AssessmentSession.findOneAndUpdate(
      {
        testLink: `${process.env.FRONTEND_URL}/assessment/${token}`,
        status: 'in-progress'
      },
      { $set: { status: 'completing' } }, // Temporary lock status
      { new: true }
    );

    if (!session) {
      return res.status(410).json({ 
        error: 'Assessment already completed, expired, or not found',
        code: 'SESSION_INVALID'
      });
    }


     // 2. Update questions with user answers if provided
    if (answers && Array.isArray(answers)) {
      const updatedQuestions = session.questions.map(q => {
        const answer = answers.find(a => a.id === q.id);
        return answer ? { ...q, userAnswer: answer.userAnswer } : q;
      });
      
      session.questions = updatedQuestions;
    
      
      await AssessmentSession.findByIdAndUpdate(session._id, {
        $set: { questions: updatedQuestions }
      });
    }
      // 2. Update the recording with session reference if not already set
      if (recordingId) {
        await Recording.findByIdAndUpdate(recordingId, {
          assessmentSession: session._id
        });
      }

    // 2. Create test result with atomic operations
    const testResult = await TestResult.findOneAndUpdate(
      {
        assessmentSession: session._id,
        status: { $ne: 'completed' } // Prevent duplicates
      },
      {
        candidateEmail: session.candidateEmail,
        jobTitle: session.jobTitle,
        score: Math.max(0, Math.min(100, score)), // Ensure score is 0-100
        status: 'completed',
        submittedAt: new Date(),
        recording: recordingId
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true
      }
    );

    // 3. Finalize session update
    await AssessmentSession.findByIdAndUpdate(session._id, {
      $set: {
        status: 'completed',
        completedAt: new Date(),
        testResult: testResult._id
      }
    });

    // 4. Expire any related pending attempts
    await TestResult.updateMany(
      {
        candidateEmail: session.candidateEmail,
        jobTitle: session.jobTitle,
        status: 'pending',
        _id: { $ne: testResult._id }
      },
      { $set: { status: 'expired' } }
    );

    // 5. Successful response
    res.status(200).json({
      success: true,
      message: 'Assessment submitted successfully',
      data: {
        score: testResult.score,
        completedAt: testResult.submittedAt,
        recordingId: testResult.recording
      },
      metadata: {
        warning: 'This assessment link is now invalid',
        retakeAllowed: false
      }
    });


  } catch (error) {
    console.error('Assessment completion error:', error);
    
    // Revert any partial changes
    await AssessmentSession.updateOne(
      { testLink: `${process.env.FRONTEND_URL}/assessment/${token}` },
      { $set: { status: 'in-progress' } }
    );

    res.status(500).json({
      error: 'Failed to complete assessment',
      code: 'SERVER_ERROR',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Add this new endpoint to your server.js
app.patch('/api/update-answer/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const { questionId, userAnswer } = req.body;

    // Atomic update of the specific question answer
    const result = await AssessmentSession.updateOne(
      {
        testLink: `${process.env.FRONTEND_URL}/assessment/${token}`,
        'questions.id': questionId
      },
      {
        $set: { 'questions.$.userAnswer': userAnswer }
      }
    );

    if (result.nModified === 0) {
      return res.status(404).json({ error: 'Question or session not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating answer:', error);
    res.status(500).json({ error: 'Failed to update answer' });
  }
});

// Add near other endpoints
app.post('/api/generate-report/:sessionId', authenticateJWT, verifyOwnership(AssessmentSession), async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    // Generate and store report
    const report = await generateAssessmentReport(sessionId, req.user.id);
    
    // Get signed URL for download
    const command = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: report.s3Key
    });
    const downloadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
    
    // Send email notification
    const session = await AssessmentSession.findById(sessionId);
    await sendReportEmail(
      req.user.email,
      downloadUrl,
      session.candidateEmail,
      session.jobTitle
    );
    
    res.json({
      success: true,
      message: 'Report generated and sent successfully',
      downloadUrl,
      reportId: report.reportId
    });
  } catch (error) {
    console.error('Report generation error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate report',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});
// Add this middleware to check assessment validity
// Enhanced validation endpoint
app.get('/api/validate-assessment/:token', async (req, res) => {
  try {
    const session = await AssessmentSession.findOne({
      testLink: `${process.env.FRONTEND_URL}/assessment/${req.params.token}`
    }).populate('testResult');

    if (!session) {
      return res.status(404).json({ 
        valid: false, 
        error: 'Assessment not found',
        status: 'not-found'
      });
    }

    if (session.status === 'completed' || session.testResult?.status === 'completed') {
      return res.json({ 
        valid: false, 
        error: 'This assessment has already been completed',
        status: 'completed'
      });
    }

    // Check expiration (24 hours)
    const hoursSinceCreation = (new Date() - session.createdAt) / (1000 * 60 * 60);
    if (hoursSinceCreation > 24) {
      await AssessmentSession.findByIdAndUpdate(session._id, { status: 'expired' });
      return res.json({ 
        valid: false, 
        error: 'This assessment link has expired',
        status: 'expired'
      });
    }

    res.json({ valid: true, session });
  } catch (error) {
    console.error('Validation error:', error);
    res.status(500).json({ 
      valid: false, 
      error: 'Validation failed',
      status: 'error'
    });
  }
});
// Add to server.js
app.get('/api/assessment-questions/:token', async (req, res) => {
  try {
    const session = await AssessmentSession.findOne({
      testLink: `${process.env.FRONTEND_URL}/assessment/${req.params.token}`
    }).select('questions voiceQuestions');
    
    if (!session) {
      return res.status(404).json({ error: 'Assessment session not found' });
    }
    
    res.json({ 
      questions: session.questions,
      voiceQuestions: session.voiceQuestions
    });
  } catch (error) {
    console.error('Error fetching questions:', error);
    res.status(500).json({ error: 'Failed to fetch assessment questions' });
  }
});
// Submit Test Score
app.post('/api/submit-score', async (req, res) => {
  const { token, score } = req.body;

  // Find the test result by token
  const testResult = await TestResult.findOne({ testLink: `${process.env.FRONTEND_URL}/quiz/${token}` });

  if (!testResult) {
    return res.status(404).json({ error: 'Test link not found.' });
  }

  if (testResult.expired) {
    return res.status(400).json({ error: 'Test link has expired.' });
  }

  // Update the test result with the score
  testResult.score = score;
  testResult.submittedAt = new Date();
  testResult.expired = true;
  await testResult.save();

  res.status(200).json({ message: 'Test score submitted successfully!' });
});
app.get('/api/recording/:id/play', async (req, res) => {
  try {
    const recording = await Recording.findById(req.params.id);
    if (!recording) {
      return res.status(404).json({ error: 'Recording not found' });
    }

    const command = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: recording.videoPath
    });
    
    const url = await getSignedUrl(s3, command);
    res.json({ url });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get recording' });
  }
});

// Similar endpoint for screen recording and audio answers
// Fetch Test Results
// Updated test-results endpoint
app.get('/api/test-results',authenticateJWT, async (req, res) => {
  try {
   
 const query = { user: req.user.id };
    if (req.user.isAdmin) {
      delete query.user; // Admins see all results
    }
    
    const testScores = await TestResult.find(query)
      .populate('assessmentSession')
      .sort({ createdAt: -1 });
    res.status(200).json(testScores);
  } catch (error) {
    console.error('Error fetching test results:', error);
    res.status(500).json({ error: 'Failed to fetch test results.' });
  }
});


// Start voice assessment phase
app.post('/api/start-voice-assessment', async (req, res) => {
  try {
    const { token } = req.body;
    
    const session = await AssessmentSession.findOneAndUpdate(
      { testLink: `${process.env.FRONTEND_URL}/assessment/${token}` },
      { $set: { currentPhase: 'voice' } },
      { new: true }
    );
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    res.status(200).json(session);
  } catch (error) {
    console.error('Error starting voice assessment:', error);
    res.status(500).json({ error: 'Failed to start voice assessment' });
  }
});

app.post('/api/submit-voice-answer', (req, res) => {
  audioUpload(req, res, async (err) => {
    try {
      const { token, questionId, question, skipped, durationSec } = req.body;
      
      // Error handling for upload
      if (err) {
        return res.status(400).json({ error: err.message });
      }
      
      if (!req.file && !skipped) {
        return res.status(400).json({ error: 'No audio file uploaded' });
      }

      // Find session
      const session = await AssessmentSession.findOne({
        testLink: `${process.env.FRONTEND_URL}/assessment/${token}`
      });
      
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Handle skipped questions
      if (skipped) {
        const voiceAnswer = new VoiceAnswer({
          questionId,
          question,
          answered: false,
          valid: false,
          skipReason: 'timeout',
          processingStatus: 'skipped',
          assessmentSession: session._id,
          durationSec: durationSec || 0
        });

        await voiceAnswer.save();
        return res.status(200).json({ 
          success: true,
          answerId: voiceAnswer._id,
          skipped: true
        });
      }

      // Validate audio before upload
      const validation = await validateAudio(req.file.buffer);
      const s3Key = `audio/answer_${Date.now()}_${questionId}.wav`;

      // Create voice answer document first
      const voiceAnswer = new VoiceAnswer({
        questionId,
        question,
        audioPath: validation.valid ? s3Key : null,
        durationSec: req.file.buffer.length / (16000 * 2),
        answered: true,
        valid: validation.valid,
        processingStatus: validation.valid ? 'pending' : 'skipped',
        skipReason: validation.reason,
        assessmentSession: session._id
      });

      await voiceAnswer.save();

      // Only proceed with upload and processing if audio is valid
      if (validation.valid) {
        try {
          // Create a fresh stream from the buffer
          const audioStream = Readable.from(req.file.buffer);
          
          // Upload to S3 with explicit WAV MIME type
          await uploadToS3(audioStream, s3Key, 'audio/wav');
          
          // Start transcription in background
          processTranscription(voiceAnswer._id).catch(transcriptionError => {
            console.error('Transcription processing failed:', transcriptionError);
          });
        } catch (uploadError) {
          console.error('Audio upload failed:', uploadError);
          // Update status if upload fails
          await VoiceAnswer.findByIdAndUpdate(voiceAnswer._id, {
            processingStatus: 'failed',
            skipReason: 'upload_failed'
          });
          throw uploadError;
        }
      }

      session.voiceAnswers.push(voiceAnswer._id);
      await session.save();
      
      // Trigger audio analysis in background
      setTimeout(async () => {
        try {
          // Update status to processing
          await VoiceAnswer.findByIdAndUpdate(voiceAnswer._id, {
            'audioAnalysis.status': 'processing'
          });

          // Analyze audio
          const gradingResult = await analyzeAudio([voiceAnswer.audioPath]);
          
          // Save analysis results
          await VoiceAnswer.findByIdAndUpdate(voiceAnswer._id, {
            audioAnalysis: {
              grading: gradingResult,
              processedAt: new Date(),
              status: 'completed'
            },
            processingStatus: 'completed'
          });

          // Calculate average score for all answers in this session
          const completedAnswers = await VoiceAnswer.find({
            assessmentSession: session._id,
            'audioAnalysis.status': 'completed',
            'audioAnalysis.grading.Total Score': { $exists: true }
          });

          if (completedAnswers.length > 0) {
            const totalScore = completedAnswers.reduce((sum, answer) => {
              return sum + (answer.audioAnalysis.grading['Total Score'] || 0);
            }, 0);
            const averageScore = totalScore / completedAnswers.length;

            // Update TestResult with the average audio score
            await TestResult.findOneAndUpdate(
              { assessmentSession: session._id },
              { audioScore: averageScore },
              { new: true }
            );
          }
        } catch (error) {
          await VoiceAnswer.findByIdAndUpdate(voiceAnswer._id, {
            'audioAnalysis.status': 'failed'
          });
          console.error('Audio analysis error:', error);
        }
      }, 0);

      res.status(200).json({ 
        success: true,
        answerId: voiceAnswer._id,
           valid: validation.valid,
        reason: validation.reason,
    format: 'wav'
      });
      
    } catch (error) {
      // Cleanup any leftover files
      if (req.file?.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      
      console.error('Voice answer submission error:', error);
      res.status(500).json({ 
        error: 'Failed to submit voice answer',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  });
});
// Add these new endpoints
app.get('/api/recording/:id/analysis', async (req, res) => {
  try {
    const recording = await Recording.findById(req.params.id);
    if (!recording) {
      return res.status(404).json({ error: 'Recording not found' });
    }
    res.json(recording.videoAnalysis);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get analysis' });
  }
});

app.get('/api/voice-answer/:id/analysis', async (req, res) => {
  try {
    const answer = await VoiceAnswer.findById(req.params.id);
    if (!answer) {
      return res.status(404).json({ error: 'Answer not found' });
    }
    res.json(answer.audioAnalysis);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get analysis' });
  }
});
// Update the complete-voice-assessment endpoint
app.post('/api/complete-voice-assessment', async (req, res) => {
  const { token, recordingId } = req.body;

  try {
    const session = await AssessmentSession.findOneAndUpdate(
      { testLink: `${process.env.FRONTEND_URL}/assessment/${token}` },
      {   
        $set: { 
          currentPhase: 'completed',
          status: 'completed',
          completedAt: new Date(),
          recording: recordingId // Store recording reference
        }
      },
      { new: true }
    );
     // Ensure the recording references the session
     if (recordingId) {
      await Recording.findByIdAndUpdate(recordingId, {
        assessmentSession: session._id
      });
    }
    
  // Non-blocking processing
    processAssessmentCompletion(session._id, session.user)
      .catch(err => console.error('Background processing error:', err));

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error completing voice assessment:', error);
    res.status(500).json({ error: 'Failed to complete assessment' });
  }
});


async function processAssessmentCompletion(sessionId, userId) {
  try {
    // 1. Atomic status check and update
    const session = await AssessmentSession.findOneAndUpdate(
      {
        _id: sessionId,
        reportStatus: { $in: ['pending', 'failed'] } // Only process if not already completed/processing
      },
      { $set: { reportStatus: 'processing' } },
      { new: true }
    );

    if (!session) {
      console.log('Report already being processed or completed for session:', sessionId);
      return;
    }

    // 2. Generate report (existing logic)
    await calculateAndStoreScores(sessionId);
    const report = await generateAssessmentReport(sessionId, userId);

    // 3. Mark as completed
    await AssessmentSession.findByIdAndUpdate(sessionId, {
      reportStatus: 'completed',
      reportGeneratedAt: new Date()
    });

    console.log('Successfully processed assessment:', sessionId);
    return report;
  } catch (error) {
    // 4. Handle failures
    await AssessmentSession.findByIdAndUpdate(sessionId, {
      reportStatus: 'failed'
    });
    console.error('Failed to process assessment:', error);
    throw error;
  }
}
async function sendReportToHR(sessionId, userId, s3Key) {
  try {
    // Get session and user details
    const [session, user] = await Promise.all([
      AssessmentSession.findById(sessionId),
      User.findById(userId)
    ]);

    if (!session || !user) {
      throw new Error('Session or user not found');
    }

    // Generate signed URL for report
    const command = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: s3Key
    });
    const downloadUrl = await getSignedUrl(s3, command, { expiresIn: 604800 }); // 7 days

    // Send email
    const mailOptions = {
      from: `"SkillMatrix Reports" <${process.env.EMAIL_USER}>`,
      to: user.email,
      subject: `Assessment Report for ${session.candidateEmail} - ${session.jobTitle}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #2563eb;">Assessment Report Ready</h2>
          <p>The assessment report for candidate <strong>${session.candidateEmail}</strong> is now available.</p>
          <p>Position: <strong>${session.jobTitle}</strong></p>
          
          <div style="text-align: center; margin: 20px 0;">
            <a href="${downloadUrl}" 
               style="background-color: #2563eb; color: white; padding: 10px 20px; 
                      text-decoration: none; border-radius: 5px; display: inline-block;">
              Download Full Report
            </a>
          </div>
          
          <p style="color: #6b7280; font-size: 12px;">
            This report contains confidential assessment data. Please handle appropriately.
          </p>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
  } catch (error) {
    console.error('Error sending report to HR:', error);
    throw error;
  }
}

// File upload endpoint (supports both camera and screen recordings)
// File upload endpoint (supports both camera and screen recordings)
// Stream-based upload endpoint for recordings
app.post("/upload", upload.fields([{ name: "cameraFile" }, { name: "screenFile" }]), async (req, res) => {
  console.log("📥 File upload request received");

  try {
    if (!req.files || !req.files.cameraFile || !req.files.screenFile) {
      return res.status(400).json({ error: "Both camera and screen files are required" });
    }

    const { assessmentToken } = req.body;
    const session = await AssessmentSession.findOne({ 
      testLink: `${process.env.FRONTEND_URL}/assessment/${assessmentToken}` 
    });

    if (!session) {
      return res.status(404).json({ error: 'Assessment session not found' });
    }

    // 1. Create recording with "processing" status
    const recording = new Recording({
      filename: req.files.cameraFile[0].originalname,
      assessmentSession: session._id,
      videoAnalysis: { 
        status: 'processing',
        startedAt: new Date() 
      }
    });
    await recording.save();
    session.recording = recording._id;
    await session.save();

    // 2. Process videos
    try {
      // Generate S3 keys first
      const timestamp = Date.now();
      const cameraKey = `video/session_${recording._id}_camera_${timestamp}.webm`;
      const screenKey = `video/session_${recording._id}_screen_${timestamp}.webm`;

      // Process camera video and upload to S3 in parallel
      const [videoAnalysis] = await Promise.all([
        analyzeVideoFile(req.files.cameraFile[0]),
        uploadToS3(Readable.from(req.files.cameraFile[0].buffer), cameraKey, 'video/webm'),
        uploadToS3(Readable.from(req.files.screenFile[0].buffer), screenKey, 'video/webm')
      ]);

      console.log("Video Analysis Results:", videoAnalysis);

      // Update recording with all results
      const updateData = {
        videoPath: cameraKey,
        screenPath: screenKey,
        'videoAnalysis.emotions': videoAnalysis.emotion_results,
        'videoAnalysis.video_score': videoAnalysis.video_score,
        'videoAnalysis.status': 'completed',
        'videoAnalysis.completedAt': new Date()
      };

      const updatedRecording = await Recording.findByIdAndUpdate(
        recording._id,
        { $set: updateData },
        { new: true }
      );

      console.log("✅ Updated Recording:", updatedRecording);

      // Verify the data was saved
      const dbRecording = await Recording.findById(recording._id);
      console.log("Database Verification:", {
        emotions: dbRecording.videoAnalysis.emotions,
        video_score: dbRecording.videoAnalysis.video_score,
        status: dbRecording.videoAnalysis.status
      });

      // Calculate scores
      await calculateAndStoreVideoScore(session._id);
      await calculateAndStoreScores(session._id);

      res.status(200).json({ 
        success: true,
        recordingId: recording._id,
        message: "Processing completed successfully",
        videoScore: videoAnalysis.video_score
      });

    } catch (processingError) {
      console.error('Video processing failed:', processingError);
      await Recording.findByIdAndUpdate(recording._id, {
        'videoAnalysis.status': 'failed',
        'videoAnalysis.error': processingError.message,
        'videoAnalysis.completedAt': new Date()
      });
      res.status(500).json({ 
        success: false,
        error: "Video processing failed",
        details: processingError.message
      });
    }

  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ 
      success: false,
      error: "File processing failed",
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// Get all voice answers for a specific assessment session
app.get('/api/assessment-session/:sessionId/voice-answers',authenticateJWT, async (req, res) => {
  try {

      const session = await AssessmentSession.findOne({
      _id: req.params.sessionId,
      user: req.user.id
    });
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    const answers = await VoiceAnswer.find({
      assessmentSession: req.params.sessionId
      
    }).sort({ createdAt: 1 }); // Sort by creation time

    res.json(answers);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch voice answers' });
  }
});

// Get Combined score of all the test scores

app.get('/api/assessment-session/:sessionId/full-results',authenticateJWT, async (req, res) => {
 try {
    const session = await AssessmentSession.findOne({
      _id: req.params.sessionId,
      user: req.user.id
    }).populate('testResult').populate('voiceAnswers');

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Calculate average if not already set
    if (!session.testResult.audioScore) {
      await calculateAndStoreAudioScore(session._id);c
      await session.populate('testResult');
    }

    res.json({
      mcqScore: session.testResult.score,
      audioScore: session.testResult.audioScore,
      combinedScore: (session.testResult.score + session.testResult.audioScore) / 2,
      voiceAnswers: session.voiceAnswers
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get results' });
  }
});
app.post('/api/evaluate-answers/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const answers = await VoiceAnswer.find({
      assessmentSession: sessionId,
      answer: { $exists: true, $ne: null },
      'textEvaluation.status': { $ne: 'completed' }
    });

    // Process answers in parallel with rate limiting
    const processingPromises = answers.map(answer => 
      processVoiceAnswer(answer._id)
    );
    
    await Promise.all(processingPromises);

    res.json({ 
      success: true,
      message: `Evaluation started for ${answers.length} answers`
    });
  } catch (error) {
    console.error('Error triggering evaluation:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to start evaluation'
    });
  }
});


/*----------------------------------------------------------------------------------------------------------------------------------------------------    */



                                 /*login functionalities*/

                                        // Routes

                                   // Register a new user

const blockedDomains = process.env.BLOCKED_DOMAINS ? process.env.BLOCKED_DOMAINS.split(',') : [];

// Login
// Login with approval check
app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: 'Invalid email or password.' });

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) return res.status(400).json({ message: 'Invalid email or password.' });

    // Skip approval check for admin
    if (!user.isAdmin) {
      if (!user.isEmailVerified) {
        return res.status(400).json({ message: 'Please verify your email first.' });
      }
      
      if (!user.isApproved) {
        return res.status(400).json({ message: 'Your account is pending admin approval.' });
      }

      if (!user.isUnlimited && user.trialEnd < new Date()) {
        return res.status(400).json({ message: 'Trial expired. Contact admin.' });
      }
    }

    const token = jwt.sign(
      { 
        id: user._id, 
        isAdmin: user.isAdmin,
        email: user.email
      }, 
      JWT_SECRET, 
      { expiresIn: '1h' }
    );

    res.cookie('token', token, { 
      httpOnly: true, 
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict'
    });

    res.status(200).json({ 
      message: 'Login successful.', 
      user: {
        id: user._id,
        email: user.email,
        fullName: user.fullName,
        isAdmin: user.isAdmin
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error.' });
  }
});

// Register a new user with admin approval flow
// Updated Register Endpoint with proper error handling and responses
app.post( '/register',[
    body('fullName').notEmpty().withMessage('Full name is required'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('mobileNumber').notEmpty().withMessage('Mobile number is required'),
    body('companyName').notEmpty().withMessage('Company name is required'),
    body('designation').notEmpty().withMessage('Designation is required'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ 
          success: false,
          message: 'Validation failed',
          errors: errors.array().map(err => err.msg) 
        });
      }

      const { fullName, email, password, mobileNumber, companyName, designation } = req.body;
      const emailDomain = email.split('@')[1];
      const blockedDomains = process.env.BLOCKED_DOMAINS ? process.env.BLOCKED_DOMAINS.split(',') : [];

      if (blockedDomains.includes(emailDomain)) {
        return res.status(400).json({ 
          success: false,
          message: 'Personal email domains are not allowed. Please use your company email.' 
        });
      }

      // Check if user already exists
      const existingUser = await User.findOne({ email });
      if (existingUser) {
        return res.status(400).json({ 
          success: false,
          message: 'User with this email already exists. Please login or use a different email.' 
        });
      }

      // Hash password and create user
      const hashedPassword = await bcrypt.hash(password, 10);
      const user = new User({
        fullName,
        email,
        password: hashedPassword,
        mobileNumber,
        companyName,
        designation,
        trialEnd: new Date(Date.now() + 24 * 60 * 60 * 1000), // 1-day trial
        subscription: {
        plan: 'trial',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 1-day trial
        isActive: true,
        limits: {
        jdUploads: 1,
        resumeUploads: 10,
        assessments: 1
      }
    }
  });

      await user.save();

      // Generate verification token
      const verificationToken = jwt.sign({ email }, JWT_SECRET, { expiresIn: '1h' });
      const verificationLink = `${process.env.BACKEND_URL}/verify-email?token=${verificationToken}`;

    
      
      // Send verification email to user
      try {
        await transporter.sendMail({
          from: `"SkillMatrix AI" <${process.env.EMAIL_USER}>`,
          to: email,
          subject: 'Verify Your Email - SkillMatrix AI',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #2563eb;">Welcome to SkillMatrix AI, ${fullName}!</h2>
              <p>Thank you for registering. Please verify your email address to continue:</p>
              <div style="text-align: center; margin: 20px 0;">
                <a href="${verificationLink}" 
                   style="background-color: #2563eb; color: white; padding: 10px 20px; 
                          text-decoration: none; border-radius: 5px; display: inline-block;">
                  Verify Email
                </a>
              </div>
              <p>After verification, your account will be reviewed by our admin team.</p>
              <p>You'll receive another email once your account is approved.</p>
              <p style="font-size: 12px; color: #6b7280;">
                If you didn't request this, please ignore this email.
              </p>
            </div>
          `
        });
        console.log(`Verification email sent to ${email}`);
      } catch (emailError) {
        console.error('Failed to send verification email:', emailError);
        // Don't fail the registration if email fails
      }

      // Send admin notification
      try {
        const adminEmail = process.env.ADMIN_EMAIL || 'skillmatrixai@gmail.com';
        const adminDashboardLink = `${process.env.FRONTEND_URL}/dashboard/admin`;
        
        await transporter.sendMail({
          from: `"SkillMatrix AI" <${process.env.EMAIL_USER}>`,
          to: adminEmail,
          subject: 'New User Registration Needs Approval',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #2563eb;">New User Registration</h2>
              <p>A new user has registered and needs approval:</p>
              <ul style="list-style: none; padding: 0;">
                <li><strong>Name:</strong> ${fullName}</li>
                <li><strong>Email:</strong> ${email}</li>
                <li><strong>Company:</strong> ${companyName}</li>
                <li><strong>Designation:</strong> ${designation}</li>
                <li><strong>Mobile:</strong> ${mobileNumber}</li>
              </ul>
              <div style="text-align: center; margin: 20px 0;">
                <a href="${adminDashboardLink}" 
                   style="background-color: #2563eb; color: white; padding: 10px 20px; 
                          text-decoration: none; border-radius: 5px; display: inline-block;">
                  View in Admin Dashboard
                </a>
              </div>
              <p>Please review and approve this user within 24 hours.</p>
            </div>
          `
        });
      } catch (adminEmailError) {
        console.error('Failed to send admin notification:', adminEmailError);
      }

      // Successful response
      return res.status(201).json({ 
        success: true,
        message: 'Registration successful! Please check your email to verify your account. You will be notified once admin approves your registration.'
      });

    } catch (error) {
      console.error('Registration error:', error);
      return res.status(500).json({ 
        success: false,
        message: 'An error occurred during registration. Please try again later.'
      });
    }
  }
);

// Password Reset Token Model (add near other schemas)
const PasswordResetTokenSchema = new mongoose.Schema({
  email: { type: String, required: true },
  token: { type: String, required: true, unique: true },
  expiresAt: { type: Date, default: () => new Date(Date.now() + 15 * 60 * 1000) } // 15 mins expiry
}, { timestamps: true });

PasswordResetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // Auto-delete expired tokens
const PasswordResetToken = mongoose.model('PasswordResetToken', PasswordResetTokenSchema);

// Generate secure token (add to helper functions)
const generateResetToken = () => crypto.randomBytes(32).toString('hex');

// 1. Request Password Reset
app.post('/api/forgot-password', 
  body('email').isEmail().normalizeEmail(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Invalid email' });
    }

    const { email } = req.body;

    try {
      const user = await User.findOne({ email });
      if (!user) {
        return res.status(404).json({ error: 'Email not found' });
      }

      // Delete any existing tokens
      await PasswordResetToken.deleteMany({ email });

      // Generate and save new token
      const token = generateResetToken();
      await PasswordResetToken.create({ email, token });

      // Send email
      const resetLink = `${process.env.FRONTEND_URL}/reset-password?token=${token}&email=${encodeURIComponent(email)}`;
      
      await transporter.sendMail({
        from: `"ATS Support" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: 'Password Reset Request',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #2563eb;">Password Reset</h2>
            <p>You requested a password reset. Click below to proceed:</p>
            <a href="${resetLink}" 
               style="background-color: #2563eb; color: white; padding: 10px 20px; 
                      text-decoration: none; border-radius: 5px; display: inline-block;">
              Reset Password
            </a>
            <p style="color: #6b7280; font-size: 12px; margin-top: 20px;">
              This link expires in 15 minutes. If you didn't request this, please ignore this email.
            </p>
          </div>
        `
      });

      res.json({ success: true });
    } catch (error) {
      console.error('Password reset error:', error);
      res.status(500).json({ error: 'Failed to process request' });
    }
  }
);

// 2. Verify Token & Reset Password
app.post('/api/reset-password',
  [
    body('token').notEmpty(),
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 6 }),
    body('confirmPassword').custom((value, { req }) => value === req.body.password)
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { token, email, password } = req.body;

    try {
      // Verify token
      const resetToken = await PasswordResetToken.findOne({ token, email });
      if (!resetToken || resetToken.expiresAt < new Date()) {
        return res.status(400).json({ error: 'Invalid or expired token' });
      }

      // Update password
      const hashedPassword = await bcrypt.hash(password, 10);
      await User.updateOne({ email }, { password: hashedPassword });

      // Cleanup
      await PasswordResetToken.deleteOne({ _id: resetToken._id });

      res.json({ success: true });
    } catch (error) {
      console.error('Password reset error:', error);
      res.status(500).json({ error: 'Failed to reset password' });
    }
  }
);

// Updated Verify Email Endpoint
app.get('/verify-email', async (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.status(400).render('verifyError', {
      errorMessage: 'Verification token is missing.'
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    const user = await User.findOneAndUpdate(
      { email: decoded.email },
      { isEmailVerified: true },
      { new: true }
    );

    if (!user) {
      return res.status(400).render('verifyError', {
        errorMessage: 'Invalid token or user not found.'
      });
    }

    return res.render('verifySuccess');

  } catch (error) {
    console.error('Email verification error:', error);

    let msg = 'Email verification failed.';
    if (error.name === 'TokenExpiredError') {
      msg = 'Verification link has expired. Please request a new one.';
    } else if (error.name === 'JsonWebTokenError') {
      msg = 'Invalid verification token.';
    }

    return res.status(400).render('verifyError', { errorMessage: msg });
  }
});
                              
// Admin dashboard (protected route)
app.get('/admin', authenticateJWT, isAdmin, async (req, res) => {
  try {
    const users = await User.find({}).select('-password');
    res.status(200).json({ users });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error.' });
  }
});
app.put('/admin/update-subscription/:userId', authenticateJWT, isAdmin, async (req, res) => {
  try {
    const { plan, months } = req.body;
    const userId = req.params.userId;
    const now = new Date();

    const updateData = {
      subscription: {
        plan,
        startedAt: now,
        isActive: true
      },
      usage: { jdUploads: 0, resumeUploads: 0, assessments: 0 } // Reset usage
    };

    switch(plan) {
      case 'trial':
        updateData.subscription.expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        updateData.subscription.limits = {
          jdUploads: 1,
          resumeUploads: 5,
          assessments: 1
        };
        break;

      case 'free':
        updateData.subscription.expiresAt = null; // Never expires
        updateData.subscription.limits = {
          jdUploads: 10,
          resumeUploads: 50,
          assessments: 5
        };
        break;

      case 'paid':
        if (!months) return res.status(400).json({ error: 'Months required' });
        updateData.subscription.expiresAt = new Date(now.getTime() + months * 30 * 24 * 60 * 60 * 1000);
        updateData.subscription.$unset = { limits: "" }; // No limits for paid
        break;
    }

    const user = await User.findByIdAndUpdate(
      userId,
      { 
        ...updateData,
        $unset: { 
          trialStart: "", 
          trialEnd: "", 
          isUnlimited: "" 
        }
      },
      { new: true }
    );

    res.status(200).json({ success: true, user });
  } catch (error) {
    res.status(500).json({ 
      success: false,
      message: 'Failed to update subscription',
      error: error.message 
    });
  }
});
// Admin approve user endpoint
app.post('/admin/approve-user/:userId', authenticateJWT, isAdmin, async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.params.userId,
      { 
        isApproved: true,
        trialStart: new Date(),
        trialEnd: new Date(Date.now() + 24 * 60 * 60 * 1000) // 1-day trial
      },
      { new: true }
    );

    if (!user) return res.status(404).json({ message: 'User not found.' });

    // Send approval email to user
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: user.email,
      subject: 'Your Account Has Been Approved - SkillMatrix AI',
      html: `
        <p>Dear ${user.fullName},</p>
        <p>Your account has been approved by the admin team. You can now login and start using SkillMatrix AI.</p>
        <p>You have a 1-day trial period. After that, please contact the admin to extend your access.</p>
        <a href="${process.env.FRONTEND_URL}/login">Login Now</a>
        <p>Thank you for choosing SkillMatrix AI!</p>
      `
    });

    res.status(200).json({ 
      message: 'User approved successfully.',
      user: {
        id: user._id,
        email: user.email,
        fullName: user.fullName
      }
    });
  } catch (error) {
    console.error('Approval error:', error);
    res.status(500).json({ message: 'Failed to approve user.' });
  }
});

// Get pending users for admin
app.get('/admin/pending-users', authenticateJWT, isAdmin, async (req, res) => {
  try {
    const users = await User.find({
      isEmailVerified: true,
      isApproved: false,
      isAdmin: false
    }).select('-password');

    res.status(200).json(users);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Failed to fetch pending users.' });
  }
});

// Admin Dashboard Routes
app.get('/admin/dashboard', authenticateJWT, isAdmin, async (req, res) => {
  try {
    const users = await User.find({}).select('-password');
    const pendingUsers = await User.find({
      isEmailVerified: true,
      isApproved: false,
      isAdmin: false
    }).select('-password');
    
    const stats = {
      totalUsers: users.length,
      pendingApproval: pendingUsers.length,
      activeUsers: users.filter(u => u.isApproved).length,
      adminUsers: users.filter(u => u.isAdmin).length
    };

    res.status(200).json({ 
      success: true,
      users,
      pendingUsers,
      stats
    });
  } catch (error) {
    console.error('Admin dashboard error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Failed to load admin dashboard data' 
    });
  }
});

// Get user by ID
app.get('/admin/users/:id', authenticateJWT, isAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    if (!user) {
      return res.status(404).json({ 
        success: false,
        message: 'User not found' 
      });
    }
    res.status(200).json({ 
      success: true,
      user 
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Failed to get user' 
    });
  }
});

// Update user details
app.put('/admin/update-user/:userId', authenticateJWT, isAdmin, async (req, res) => {
  const { userId } = req.params;
  const { fullName, email, mobileNumber, companyName, designation, trialEnd, isUnlimited } = req.body;

  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    if (fullName) user.fullName = fullName;
    if (email) user.email = email;
    if (mobileNumber) user.mobileNumber = mobileNumber;
    if (companyName) user.companyName = companyName;
    if (designation) user.designation = designation;
    if (trialEnd) user.trialEnd = trialEnd;
    if (isUnlimited !== undefined) user.isUnlimited = isUnlimited;

    await user.save();
    res.status(200).json({ message: 'User updated successfully.', user });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error.' });
  }
});

// Delete user
app.delete('/admin/delete-user/:userId', authenticateJWT, isAdmin, async (req, res) => {
  const { userId } = req.params;

  try {
    const user = await User.findByIdAndDelete(userId);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    res.status(200).json({ message: 'User deleted successfully.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error.' });
  }
});

// Extend trial period
app.put('/admin/extend-trial/:userId', authenticateJWT, isAdmin, async (req, res) => {
  const { userId } = req.params;
  const { days } = req.body;

  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    const newTrialEnd = new Date(user.trialEnd);
    newTrialEnd.setDate(newTrialEnd.getDate() + days); // Extend trial by 'days'
    user.trialEnd = newTrialEnd;

    await user.save();
    res.status(200).json({ message: 'Trial extended successfully.', user });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error.' });
  }
});
// User profile (protected route)
app.get('/user', authenticateJWT, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    res.status(200).json({ user });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error.' });
  }
});

// Register
app.post('/jobportal/register', async (req, res) => {
  const { name, email, password } = req.body;
  const blocked = ['gmail.com', 'yahoo.com', 'hotmail.com'];
  const domain = email.split('@')[1];
  if (blocked.includes(domain)) {
    return res.status(400).json({ message: 'Only company emails allowed.' });
  }
  const existing = await JobPoster.findOne({ email });
  if (existing) return res.status(400).json({ message: 'Email already registered.' });

  const hashedPassword = await bcrypt.hash(password, 10);
  const newUser = await JobPoster.create({ name, email, password: hashedPassword });

  const token = jwt.sign({ id: newUser._id }, JWT_SECRET, { expiresIn: '1h' });
  const verifyLink = `${process.env.BACKEND_URL}/jobportal/verify?token=${token}`;

  await transporter.sendMail({
    to: email,
    from: `"SkillMatrix Jobs" <${process.env.EMAIL_USER}>`,
    subject: 'Verify your email for Job Posting',
    html: `<p>Please verify your email: <a href="${verifyLink}">Verify Now</a></p>`
  });
  res.status(200).json({ message: 'Verification email sent.' });
});

// Verify
app.get('/jobportal/verify', async (req, res) => {
  try {
    const { token } = req.query;
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await JobPoster.findById(decoded.id);
    if (!user) return res.render('verifyError', { errorMessage: 'Invalid user.' });
    user.isVerified = true;
    await user.save();
    res.render('verifySuccess');
  } catch (e) {
    res.render('verifyError', { errorMessage: 'Invalid or expired token.' });
  }
});

// Login
app.post('/jobportal/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await JobPoster.findOne({ email });
  if (!user) return res.status(400).json({ message: 'Invalid credentials.' });
  if (!user.isVerified) return res.status(400).json({ message: 'Please verify your email.' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(400).json({ message: 'Invalid credentials.' });
const token = jwt.sign({ _id: user._id, email: user.email }, JWT_SECRET);

  res.cookie('jobToken', token, {
    httpOnly: true,
    sameSite: 'Strict',
    secure: process.env.NODE_ENV === 'production'
  });
  res.status(200).json({ message: 'Login successful' });
});
// Get job by publicId
app.get('/public/job/:publicId', async (req, res) => {
  try {
    const job = await JobPost.findOne({ publicId: req.params.publicId })
      .populate('postedBy', 'name email');
    
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    res.json(job);
  } catch (error) {
    console.error('Error fetching public job:', error);
    res.status(500).json({ error: 'Failed to fetch job details' });
  }
});
// ✅ Job Posting Route
app.post('/jobportal/post', authenticateJobPoster, upload.single('jobDescription'), async (req, res) => {
  try {
     console.log('Received data:', req.body); // Add this for debugging
    const {
      title,
      companyName, // NEW FIELD
      location,
      experience,
      jobType,
      department,
      skillsRequired,
      salaryRange,
      descriptionText
    } = req.body;

    let s3Key = '';
    const file = req.file;

    if (file) {
      const safeTitle = title.replace(/\s+/g, '_');
      const fileName = `JD_${safeTitle}_${Date.now()}_${uuidv4()}${path.extname(file.originalname)}`;
      const folderPrefix = process.env.S3_JD_FOLDER || 'jobposting-jd-files';
      const key = `${folderPrefix}/${fileName}`;
      const result = await uploadToS3(file.buffer, key, file.mimetype);
      s3Key = result?.Key || key;
    }

    const job = new JobPost({
      title,
      companyName, // NEW FIELD
      location,
      experience,
      jobType,
      department,
      skillsRequired: skillsRequired?.split(',').map(skill => skill.trim()) || [],
      salaryRange,
      descriptionText,
      jobDescriptionFile: s3Key,
      postedBy: req.user._id
    });

    await job.save();
    return res.status(201).json({ message: 'Job posted successfully!', jobId: job._id });
  } catch (err) {
    console.error('Error in Job Posting:', err);
    return res.status(500).json({ message: 'Failed to post job' });
  }
});

// ✅ View JD File via Signed URL
// Updated view-jd endpoint to handle resume downloads

app.get('/jobportal/myjobs', authenticateJobPoster, async (req, res) => {
  try {
    const jobs = await JobPost.find({ postedBy: req.user._id }).sort({ createdAt: -1 });
    res.status(200).json({ jobs });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch jobs' });
  }
});

// ✅ NEW ENDPOINT: JobPoster Profile Fetch
app.get('/jobportal/profile', authenticateJobPoster, async (req, res) => {
  try {
    const jobPoster = await JobPoster.findById(req.user._id).select('-password');
    if (!jobPoster) return res.status(404).json({ message: 'Job poster not found' });
    res.status(200).json({ user: jobPoster });
  } catch (err) {
    console.error('Error fetching job poster profile:', err);
    res.status(500).json({ message: 'Failed to fetch profile' });
  }
});

// Generate public URL (add after job posting)
app.post('/jobportal/generate-public-url/:jobId', authenticateJobPoster, async (req, res) => {
  try {
    const job = await JobPost.findById(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    
    job.publicId = `job-${uuidv4().split('-')[0]}`;
    await job.save();
    
    res.json({ 
      publicUrl: `${process.env.FRONTEND_URL}/jobs/${job.publicId}` 
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate URL' });
  }
});
// Public JD View Endpoint
// Public JD View Endpoint
app.get('/public/view-jd/:jobId', async (req, res) => {
  try {
    const job = await JobPost.findById(req.params.jobId);
    if (!job || !job.jobDescriptionFile) {
      return res.status(404).json({ error: 'Job description file not found' });
    }

    const filename = `JobDescription_${job.title.replace(/\s+/g, '_')}${path.extname(job.jobDescriptionFile)}`;
    const signedUrl = await getSignedUrlForS3(job.jobDescriptionFile);
    
    res.status(200).json({ 
      success: true, 
      url: signedUrl,
      filename 
    });
  } catch (error) {
    console.error('Error viewing JD file:', error);
    res.status(500).json({ error: 'Failed to generate file URL' });
  }
});

// HR JD View Endpoint (authenticated)
app.get('/jobportal/view-jd/:jobId', authenticateJobPoster, async (req, res) => {
  try {
    const job = await JobPost.findById(req.params.jobId);
    if (!job || !job.jobDescriptionFile) {
      return res.status(404).json({ error: 'Job description file not found' });
    }

    const filename = `JobDescription_${job.title.replace(/\s+/g, '_')}${path.extname(job.jobDescriptionFile)}`;
    const signedUrl = await getSignedUrlForS3(job.jobDescriptionFile);
    
    res.status(200).json({ 
      success: true, 
      url: signedUrl,
      filename 
    });
  } catch (error) {
    console.error('Error viewing JD file:', error);
    res.status(500).json({ error: 'Failed to generate file URL' });
  }
});

// Resume View Endpoint
app.get('/jobportal/view-resume/:applicationId', authenticateJobPoster, async (req, res) => {
  try {
    const application = await Application.findById(req.params.applicationId);
    if (!application || !application.resumeFile) {
      return res.status(404).json({ error: 'Resume not found' });
    }

    const filename = `Resume_${application.candidateName.replace(/\s+/g, '_')}${path.extname(application.resumeFile)}`;
    const signedUrl = await getSignedUrlForS3(application.resumeFile);
    
    res.status(200).json({ 
      success: true, 
      url: signedUrl,
      filename 
    });
  } catch (error) {
    console.error('Error viewing resume:', error);
    res.status(500).json({ error: 'Failed to generate resume URL' });
  }
});
const downloadResume = async (applicationId, candidateName) => {
  try {
    const res = await axiosInstance.get(`/jobportal/view-resume/${applicationId}`, {
      headers: { Authorization: `Bearer ${sessionStorage.getItem('jobToken')}` }
    });
    
    if (res.data?.url) {
      const link = document.createElement('a');
      link.href = res.data.url;
      link.download = `${candidateName.replace(/\s+/g, '_')}_Resume${path.extname(res.data.filename)}`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  } catch (err) {
    toast.error('Failed to download resume');
    console.error(err);
  }
};



// Candidate application
app.post('/public/apply/:jobId', upload.single('resume'), async (req, res) => {
  try {
    const job = await JobPost.findById(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    let resumeKey = '';
    if (req.file) {
      const fileName = `resume_${Date.now()}_${req.file.originalname}`;
      resumeKey = `applications/${fileName}`;
      await uploadToS3(req.file.buffer, resumeKey, req.file.mimetype);
    }

    const application = await Application.create({
      jobId: job._id,
      candidateName: req.body.name,
      candidateEmail: req.body.email,
      candidatePhone: req.body.phone,
      resumeFile: resumeKey
    });

    job.applications.push(application._id);
    await job.save();

    // TODO: Send email notification to HR
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Application failed' });
  }
});

// Get applications for HR
app.get('/jobportal/applications/:jobId', authenticateJobPoster, async (req, res) => {
  try {
    const applications = await Application.find({ jobId: req.params.jobId });
    res.json(applications);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch applications' });
  }
});


// Admin related JobPost detail access 
// Get all job posters (HR users)
app.get('/admin/jobposters', authenticateJWT, isAdmin, async (req, res) => {
  try {
    const posters = await JobPoster.find({});
    const postersWithCount = await Promise.all(posters.map(async poster => {
      const count = await JobPost.countDocuments({ postedBy: poster._id });
      return { ...poster.toObject(), jobCount: count };
    }));
    res.json(postersWithCount);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch job posters' });
  }
});

// Get jobs by HR user (admin version)
app.get('/jobportal/admin/jobs/:hrId', authenticateJWT, isAdmin, async (req, res) => {
  try {
    const jobs = await JobPost.find({ postedBy: req.params.hrId });
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch jobs' });
  }
});

// Get applications for job (admin version)
app.get('/jobportal/admin/applications/:jobId', authenticateJWT, isAdmin, async (req, res) => {
  try {
    const applications = await Application.find({ jobId: req.params.jobId });
    res.json(applications);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch applications' });
  }
});

// ==============================
// ✅ JOB POST SUBMISSION
// ==============================



// ==========================
// Save admin details on startup

// Save admin details on startup with enhanced error handling
// Updated saveAdmin function
const saveAdmin = async () => {
  try {
    const adminEmail = process.env.ADMIN_EMAIL || 'skillmatrixai@gmail.com';
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin@123';
    
    const adminData = {
      fullName: process.env.ADMIN_FULLNAME || 'Admin User',
      email: adminEmail,
      password: await bcrypt.hash(adminPassword, 10),
      mobileNumber: process.env.ADMIN_MOBILE || '0000000000',
      companyName: process.env.ADMIN_COMPANY || 'SkillMatrix AI',
      designation: process.env.ADMIN_DESIGNATION || 'Admin',
      isEmailVerified: true,
      isAdmin: true,
      isApproved: true,
      // Admin has no subscription limits at all
      subscription: {
        plan: 'admin',
        isActive: true,
        // No limits object for admin
        startedAt: new Date()
      },
      // Clear all trial fields for admin
      $unset: {
        trialStart: "",
        trialEnd: "",
        isUnlimited: ""
      }
    };

    const existingAdmin = await User.findOne({ email: adminEmail });
    if (existingAdmin) {
      await User.findOneAndUpdate(
        { email: adminEmail },
        adminData,
        { new: true }
      );
      console.log('Admin user updated');
    } else {
      await User.create(adminData);
      console.log('Admin user created');
    }
  } catch (error) {
    console.error('Failed to setup admin user:', error);
  }
};

app.post('/logout', (req, res) => {
  res.clearCookie('token', { path: '/' });
  res.clearCookie('refreshToken', { path: '/' });
  res.status(200).json({ message: 'Logged out successfully' });
});
app.set('trust proxy', true); // or a specific number if you're behind multiple proxies
// Start Server
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  saveAdmin(); // Save admin details on server start
   ensureCleanTempDir();
});